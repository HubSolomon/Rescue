import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { config as defaultConfig, type Config } from "./config.js";
import { systemClock, type Clock } from "./lib/clock.js";
import { AppError } from "./lib/errors.js";
import { type TriageService } from "./lib/triage.js";
import { StubTriageModel, ValidatingTriageService } from "./lib/ai.js";
import { MockEvidenceStorage, type EvidenceStorage } from "./lib/storage.js";
import { DispatchSweep, type SweepConfig } from "./lib/dispatch.js";
import {
  CachingMaps,
  OpenStreetMapMaps,
  PostalCodeMaps,
  type MapsProvider
} from "./lib/maps.js";
import {
  LoggingNotificationSender,
  type NotificationSender
} from "./lib/notifications.js";
import { buildHandlers } from "./worker/handlers.js";
import { buildPaymentHandlers } from "./worker/payments.js";
import { MockPaymentGateway, type PaymentGateway } from "./lib/payments.js";
import { composeHandlers, OutboxWorker } from "./worker/worker.js";
import {
  DevTokenIssuer,
  DevTokenVerifier,
  OidcTokenVerifier,
  type TokenVerifier
} from "./lib/auth/verifier.js";
import { authPlugin } from "./plugins/auth.js";
import { createIdempotencyRunner } from "./plugins/idempotency.js";
import { buildOpenApiDocument } from "./openapi.js";
import { createMetrics, type AppMetrics } from "./lib/metrics.js";
import { REDACTED_LOG_PATHS } from "./lib/redaction.js";
import { metricsRoutes } from "./routes/metrics.js";
import { authRoutes } from "./routes/auth.js";
import { evidenceRoutes } from "./routes/evidence.js";
import { healthRoutes } from "./routes/health.js";
import { jobRoutes } from "./routes/jobs.js";
import { offerRoutes } from "./routes/offers.js";
import { providerRoutes } from "./routes/providers.js";
import { quoteRoutes } from "./routes/quotes.js";
import { MemoryStore } from "./store/memory.js";
import { developmentSeed } from "./seed.js";
import type { Store } from "./store/types.js";

export const API_VERSION = "0.3.0";

declare module "fastify" {
  interface FastifyInstance {
    outbox: OutboxWorker;
    sweep: DispatchSweep;
    systemActor: { userId: string | null; role: "DISPATCHER"; correlationId: string };
    metrics: AppMetrics;
  }
}

export interface BuildAppOptions {
  config?: Config;
  store?: Store;
  triage?: TriageService;
  storage?: EvidenceStorage;
  notifications?: NotificationSender;
  gateway?: PaymentGateway;
  maps?: MapsProvider;
  sweep?: Partial<SweepConfig>;
  clock?: Clock;
  verifier?: TokenVerifier;
  rateLimitMax?: number;
  metrics?: AppMetrics;
  /**
   * Where log lines go. Only a test passes this, and the reason it exists is
   * that redaction is worth nothing unless it is proven on the logger the app
   * actually runs -- a test that constructs its own pino with the same options
   * proves the options, not the wiring.
   */
  logStream?: NodeJS.WritableStream;
}

function statusCodeOf(error: unknown): number | undefined {
  const candidate = (error as { statusCode?: unknown }).statusCode;
  return typeof candidate === "number" ? candidate : undefined;
}

function errorCodeOf(error: unknown, fallback: string): string {
  const candidate = (error as { code?: unknown }).code;
  return typeof candidate === "string" ? candidate : fallback;
}

/**
 * Chooses the token verifier.
 *
 * Production must have a real identity provider. The symmetric development
 * verifier is not merely discouraged there -- it cannot be constructed, so a
 * misconfigured deployment fails to boot rather than quietly accepting
 * self-signed tokens.
 */
export function buildVerifier(config: Config): TokenVerifier {
  if (config.usesOidc) {
    return new OidcTokenVerifier(config.OIDC_ISSUER!, config.OIDC_JWKS_URI!, config.OIDC_AUDIENCE);
  }
  if (config.NODE_ENV === "production") {
    throw new Error("Refusing to start: production requires OIDC_ISSUER and OIDC_JWKS_URI");
  }
  return new DevTokenVerifier(config.JWT_SECRET);
}

/**
 * Chooses the persistence implementation.
 *
 * The Prisma module is imported lazily so a development run with no database
 * never loads the client, and so the in-memory path has no dependency on a
 * generated Prisma client existing at all.
 */
export async function createStore(config: Config): Promise<Store> {
  if (!config.DATABASE_URL) {
    return new MemoryStore(config.NODE_ENV === "production" ? {} : developmentSeed);
  }
  const [{ getDb }, { PrismaStore }] = await Promise.all([
    import("@rescue/database"),
    import("./store/prisma.js")
  ]);
  return new PrismaStore(getDb(config.DATABASE_URL));
}

export async function buildApp(options: BuildAppOptions = {}) {
  const config = options.config ?? defaultConfig;
  const clock = options.clock ?? systemClock;
  // Created per app rather than as a module singleton: two apps in one test
  // process must not share counters, and a global registry is the reason
  // metrics assertions are usually flaky.
  const metrics = options.metrics ?? createMetrics();
  // DATABASE_URL selects PostgreSQL. Without it the in-memory store runs, which
  // `parseConfig` refuses to allow in production.
  const store = options.store ?? (await createStore(config));
  /**
   * Triage always goes through validation, even with no model configured.
   *
   * With `AI_PROVIDER=mock` the "model" is a stub that answers with the rules
   * engine's own output -- which means the validated path, the provenance
   * record and the fallback are all exercised in every development run rather
   * than only in production, where finding a bug in them is expensive.
   */
  const triage: TriageService =
    options.triage ??
    new ValidatingTriageService({
      model: config.AI_PROVIDER === "mock" ? new StubTriageModel() : null,
      clock,
      onFallback: (reason, detail) => app.log.warn({ reason, detail }, "triage fell back to rules"),
      onAnswer: (provenance) =>
        metrics.triageFallbacks.increment({ source: provenance.fellBackToRules ? "rules" : "model" })
    });
  /**
   * Geography.
   *
   * The real provider only when it is configured and identified: Nominatim's
   * terms require a contactable User-Agent, and sending a generic one gets the
   * deployment blocked rather than rate-limited. Everything is wrapped in the
   * cache, which is how this stays inside those terms, and the cache falls
   * back to the offline estimate when the provider is unreachable -- with the
   * `isRoadDistance` flag false, so the degradation shows up in the console
   * instead of being quietly presented as a measurement.
   */
  const maps: MapsProvider = options.maps ?? new CachingMaps(
    config.MAPS_PROVIDER === "osm" && config.MAPS_USER_AGENT
      ? new OpenStreetMapMaps({
          userAgent: config.MAPS_USER_AGENT,
          nominatimBase: config.MAPS_NOMINATIM_URL,
          osrmBase: config.MAPS_OSRM_URL
        })
      : new PostalCodeMaps(),
    {
      now: () => clock.now(),
      ttlMs: config.MAPS_CACHE_TTL_MS,
      onFallback: (error) => app.log.warn({ err: error }, "maps provider unreachable; using the estimate"),
      onLookup: (result) => metrics.mapsLookups.increment({ result })
    }
  );
  const sweep = new DispatchSweep({ store, clock, maps, config: options.sweep });
  const storage =
    options.storage ??
    new MockEvidenceStorage(
      config.S3_ENDPOINT ?? "http://localhost:9000",
      config.S3_BUCKET,
      config.JWT_SECRET,
      config.EVIDENCE_UPLOAD_TTL_SECONDS
    );
  const verifier = options.verifier ?? buildVerifier(config);
  const hops = config.TRUST_PROXY_HOPS;

  const app = Fastify({
    logger:
      config.NODE_ENV === "test" && !options.logStream
        ? false
        : {
            // Redaction is configured on the logger rather than applied at call
            // sites, because a call site can be forgotten and this cannot.
            redact: { paths: REDACTED_LOG_PATHS, censor: "[redacted]" },
            ...(options.logStream ? { level: "trace", stream: options.logStream } : {})
          },
    // Trust X-Forwarded-For for exactly `hops` proxies and no more. `false`
    // keeps the rate limiter keyed on the real peer address, so a client
    // cannot choose its own bucket.
    trustProxy: hops === 0 ? false : (_address: string, hop: number) => hop < hops,
    bodyLimit: 2_000_000,
    // Correlation ID: honour an upstream one, otherwise generate.
    genReqId: (request) => {
      const header = request.headers["x-request-id"];
      const value = Array.isArray(header) ? header[0] : header;
      return typeof value === "string" && value.length > 0 && value.length <= 200
        ? value
        : crypto.randomUUID();
    }
  });

  /**
   * A POST with `content-type: application/json` and no body is treated as
   * `{}` rather than 400.
   *
   * Several endpoints -- start, complete, evidence confirmation -- take no
   * body at all, and clients routinely set the header anyway. Rejecting those
   * with FST_ERR_CTP_EMPTY_JSON_BODY turns a well-formed request into a
   * protocol error. Endpoints that do require a body still validate it with
   * Zod, so `{}` fails there with a proper VALIDATION_ERROR.
   */
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string", bodyLimit: 2_000_000 },
    (_request, body, done) => {
      const text = typeof body === "string" ? body.trim() : "";
      if (text.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(text));
      } catch {
        const error = new Error("Body is not valid JSON") as FastifyError;
        error.statusCode = 400;
        error.code = "FST_ERR_CTP_INVALID_JSON_BODY";
        done(error, undefined);
      }
    }
  );

  await app.register(helmet);
  await app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  await app.register(rateLimit, {
    max: options.rateLimitMax ?? config.RATE_LIMIT_MAX,
    timeWindow: "1 minute"
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", request.id);
    return payload;
  });

  /**
   * Request metrics.
   *
   * The route *template* Fastify matched, never `request.url`: a counter
   * labelled by URL gets one series per job id, which is how a metrics
   * endpoint ends up with more cardinality than the database has rows. An
   * unmatched request has no template, and is bucketed as `unmatched` rather
   * than given its path, for the same reason -- otherwise a scanner walking
   * random URLs can grow the series set without limit.
   */
  app.addHook("onResponse", async (request, reply) => {
    const route = request.routeOptions?.url ?? "unmatched";
    const method = request.method;
    metrics.httpRequests.increment({
      method,
      route,
      status: String(reply.statusCode)
    });
    metrics.httpDuration.observe({ method, route }, reply.elapsedTime / 1000);
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          // Field paths and messages only. Received values are deliberately
          // not echoed back (finding L3).
          details: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message
          }))
        }
      });
    }

    if (error instanceof AppError) {
      if (error.statusCode >= 500) request.log.error({ err: error }, "application error");
      return reply
        .code(error.statusCode)
        .send({ error: { code: error.code, message: error.message, details: error.details } });
    }

    const statusCode = statusCodeOf(error) ?? 500;

    // The rate limiter throws a plain Fastify error. Without this branch it
    // reaches the 500 fallback, which loses Retry-After, misreports throttling
    // as a server fault, and logs every throttled request at error level.
    if (statusCode === 429) {
      request.log.warn({ ip: request.ip, url: request.url }, "rate limit exceeded");
      return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
    }

    if (statusCode >= 400 && statusCode < 500) {
      request.log.warn({ err: error, url: request.url }, "client error");
      return reply
        .code(statusCode)
        .send({ error: { code: errorCodeOf(error, "BAD_REQUEST"), message: error.message } });
    }

    app.log.error(error);
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Unexpected server error" } });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: "NOT_FOUND", message: "Route not found" } })
  );

  /* ------------------------------------------------------------ assembly */

  /**
   * The actor recorded for anything the system does on its own.
   *
   * Deliberately not a person and deliberately not null: the audit log should
   * be able to answer "who did this" with "the sweep did, at 02:14", rather
   * than leaving a blank that reads like a missing record. It holds a
   * dispatcher's role because that is the authority it acts with, and nothing
   * it can do moves a job -- see tests/human-in-the-loop.test.ts.
   */
  const systemActor = { userId: null, role: "DISPATCHER" as const, correlationId: "system" };

  const notifications = options.notifications ?? new LoggingNotificationSender(app.log);
  const gateway = options.gateway ?? new MockPaymentGateway(config.JWT_SECRET);
  const worker = new OutboxWorker({
    store,
    clock,
    logger: app.log,
    // Notifications first: telling someone is cheap and safe to repeat, so a
    // payment failure retries the message without having also delayed the
    // email that should already have gone out.
    handlers: composeHandlers(
      buildHandlers({ store, sender: notifications }),
      buildPaymentHandlers({ store, gateway })
    ),
    actor: systemActor,
    pollIntervalMs: config.OUTBOX_POLL_MS,
    batchSize: config.OUTBOX_BATCH,
    onDrain: (result) => {
      for (const outcome of ["delivered", "failed", "dead", "skipped"] as const) {
        if (result[outcome] > 0) metrics.outboxOutcomes.increment({ outcome }, result[outcome]);
      }
    }
  });

  /**
   * Queue depth is read at scrape time, not counted as it changes.
   *
   * A counter in this process would be wrong the moment a second worker
   * claimed a row, and zero again after a restart. The question "are there
   * dead letters right now" only has one honest answer, and it is a query.
   */
  metrics.registry.onCollect(async () => {
    try {
      const stats = await store.outboxStats();
      for (const [status, count] of Object.entries(stats.byStatus)) {
        metrics.outboxByStatus.set({ status }, count);
      }
      metrics.outboxOldestPendingSeconds.set(
        {},
        stats.oldestUndelivered
          ? Math.max(0, (clock.now().getTime() - stats.oldestUndelivered.getTime()) / 1000)
          : 0
      );
    } catch (error) {
      // A scrape must not fail because the database blinked, or the alert that
      // would have told someone the database blinked never fires.
      app.log.warn({ err: error }, "could not collect outbox metrics");
    }
  });

  // Exposed so the server can start it, and so a test can drain it by hand
  // instead of waiting for a timer.
  app.decorate("outbox", worker);
  app.decorate("sweep", sweep);
  app.decorate("systemActor", systemActor);
  app.decorate("metrics", metrics);

  /**
   * `/metrics` exists when it can be protected, and not otherwise.
   *
   * In production that means a token; without one the route is simply not
   * registered, so a deployment that forgot to set it gets a 404 rather than
   * an open endpoint. Outside production it is open, because a development
   * machine has nothing to protect and a token would be one more thing to set
   * before anything works.
   */
  const metricsToken = config.METRICS_TOKEN ?? null;
  if (metricsToken !== null || config.NODE_ENV !== "production") {
    await app.register(metricsRoutes({ registry: metrics.registry, token: metricsToken }));
  } else {
    app.log.warn("METRICS_TOKEN is unset in production; /metrics is not exposed");
  }

  const idempotency = createIdempotencyRunner(store, config.IDEMPOTENCY_TTL_HOURS);
  const devIssuer = config.devIdentityEnabled ? new DevTokenIssuer(config.JWT_SECRET) : null;
  const openApiDocument = buildOpenApiDocument(API_VERSION);

  await app.register(authPlugin, { verifier, store });

  await app.register(
    async (scoped) => {
      scoped.get("/openapi.json", async () => openApiDocument);
      await scoped.register(
        healthRoutes({
          version: API_VERSION,
          checkReadiness: async () => {
            try {
              await store.findUserBySubject("__readiness_probe__");
              return { store: "ok" as const };
            } catch {
              return { store: "unavailable" as const };
            }
          }
        })
      );
      await scoped.register(authRoutes({ store, devIssuer }));
      await scoped.register(jobRoutes({ store, triage, idempotency }));
      await scoped.register(providerRoutes({ store, registrationHashKey: config.REGISTRATION_HASH_KEY }));
      await scoped.register(quoteRoutes({ store, idempotency, clock }));
      await scoped.register(offerRoutes({ store, idempotency, clock, sweep, maps }));
      await scoped.register(evidenceRoutes({ store, storage, clock }));
    },
    { prefix: "/v1" }
  );

  app.addHook("onClose", async () => {
    await worker.stop();
    await store.close();
  });

  return app;
}
