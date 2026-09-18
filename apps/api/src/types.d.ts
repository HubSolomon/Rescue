import "fastify";
import type { JobStore } from "./lib/job-store.js";
import type { TriageService } from "./lib/triage.js";

declare module "fastify" {
  interface FastifyInstance { services: { jobStore: JobStore; triage: TriageService }; }
}
