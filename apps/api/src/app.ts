import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { ZodError } from "zod";
import { config } from "./config.js";
import { AppError } from "./lib/errors.js";
import { InMemoryJobStore, type JobStore } from "./lib/job-store.js";
import { RulesFirstTriageService, type TriageService } from "./lib/triage.js";
import { healthRoutes } from "./routes/health.js";
import { jobRoutes } from "./routes/jobs.js";

/** Reads a numeric `statusCode` off an unknown error without widening to `any`. */
function statusCodeOf(error: unknown): number | undefined {
  const candidate = (error as { statusCode?: unknown }).statusCode;
  return typeof candidate === "number" ? candidate : undefined;
}

function errorCodeOf(error: unknown, fallback: string): string {
  const candidate = (error as { code?: unknown }).code;
  return typeof candidate === "string" ? candidate : fallback;
}

export async function buildApp(
  overrides: { jobStore?: JobStore; triage?: TriageService; rateLimitMax?: number } = {}
) {
  const hops = config.TRUST_PROXY_HOPS;
  const app = Fastify({
    logger: config.NODE_ENV !== "test",
    // Trust X-Forwarded-For for exactly the first `hops` proxies and no more.
    // `false` (the default) means the rate limiter keys on the real peer
    // address, so a client cannot choose its own bucket.
    trustProxy: hops === 0 ? false : (_address: string, hop: number) => hop < hops,
    bodyLimit: 2_000_000
  });
  await app.register(helmet);
  await app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  await app.register(rateLimit, { max: overrides.rateLimitMax ?? 100, timeWindow: "1 minute" });
  app.decorate("services", {
    jobStore: overrides.jobStore ?? new InMemoryJobStore(),
    triage: overrides.triage ?? new RulesFirstTriageService()
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ZodError) {
      return reply
        .code(400)
        .send({ error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: error.issues } });
    }

    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }

    const statusCode = statusCodeOf(error) ?? 500;

    // The rate limiter throws a plain Fastify error. Without this branch it
    // reaches the 500 fallback below, which loses Retry-After, misreports
    // throttling as a server fault, and logs every throttled request at
    // error level.
    if (statusCode === 429) {
      request.log.warn({ ip: request.ip, url: request.url }, "rate limit exceeded");
      return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } });
    }

    // Client errors are the caller's problem, not an incident. Logging them at
    // error level lets anyone flood the error stream on demand.
    if (statusCode >= 400 && statusCode < 500) {
      request.log.warn({ err: error, url: request.url }, "client error");
      return reply.code(statusCode).send({ error: { code: errorCodeOf(error, "BAD_REQUEST"), message: error.message } });
    }

    app.log.error(error);
    return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Unexpected server error" } });
  });

  await app.register(healthRoutes, { prefix: "/v1" });
  await app.register(jobRoutes, { prefix: "/v1" });
  return app;
}
