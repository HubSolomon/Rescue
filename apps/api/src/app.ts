import Fastify from "fastify";
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

export async function buildApp(overrides: { jobStore?: JobStore; triage?: TriageService } = {}) {
  const app = Fastify({ logger: config.NODE_ENV !== "test", trustProxy: true, bodyLimit: 2_000_000 });
  await app.register(helmet);
  await app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  await app.register(rateLimit, { max: 100, timeWindow: "1 minute" });
  app.decorate("services", { jobStore: overrides.jobStore ?? new InMemoryJobStore(), triage: overrides.triage ?? new RulesFirstTriageService() });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ error: { code: "VALIDATION_ERROR", message: "Request validation failed", details: error.issues } });
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    app.log.error(error); return reply.code(500).send({ error: { code: "INTERNAL_ERROR", message: "Unexpected server error" } });
  });
  await app.register(healthRoutes, { prefix: "/v1" });
  await app.register(jobRoutes, { prefix: "/v1" });
  return app;
}
