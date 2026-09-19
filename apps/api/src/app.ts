import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { config as defaultConfig, type Config } from "./config.js";
import { systemClock, type Clock } from "./lib/clock.js";
import { AppError } from "./lib/errors.js";
import { RulesFirstTriageService, type TriageService } from "./lib/triage.js";
import { MockEvidenceStorage, type EvidenceStorage } from "./lib/storage.js";
import {
  DevTokenIssuer,
  DevTokenVerifier,
  OidcTokenVerifier,
  type TokenVerifier
} from "./lib/auth/verifier.js";
import { authPlugin } from "./plugins/auth.js";
import { createIdempotencyRunner } from "./plugins/idempotency.js";
import { buildOpenApiDocument } from "./openapi.js";
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

export const API_VERSION = "0.2.0";

export interface BuildAppOptions {
  config?: Config;
  store?: Store;
  triage?: TriageService;
  storage?: EvidenceStorage;
  clock?: Clock;
  verifier?: TokenVerifier;
  rateLimitMax?: number;
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
  // DATABASE_URL selects PostgreSQL. Without it the in-memory store runs, which
  // `parseConfig` refuses to allow in production.
  const store = options.store ?? (await createStore(config));
  const triage = options.triage ?? new RulesFirstTriageService();
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
    logger: config.NODE_ENV !== "test",
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

  await app.register(helmet);
  await app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  await app.register(rateLimit, { max: options.rateLimitMax ?? 100, timeWindow: "1 minute" });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-request-id", request.id);
    return payload;
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
      await scoped.register(offerRoutes({ store, idempotency, clock }));
      await scoped.register(evidenceRoutes({ store, storage, clock }));
    },
    { prefix: "/v1" }
  );

  app.addHook("onClose", async () => {
    await store.close();
  });

  return app;
}
