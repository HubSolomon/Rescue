import type { FastifyPluginAsync } from "fastify";
import { createJobSchema } from "@rescue/contracts";
import { AppError } from "../lib/errors.js";

export const jobRoutes: FastifyPluginAsync = async (app) => {
  app.post("/jobs", async (request, reply) => {
    const input = createJobSchema.parse(request.body);
    const job = await app.services.jobStore.create(input);
    const triage = await app.services.triage.suggest(input);
    return reply.code(201).send({ data: { job, triage }, meta: { humanApprovalRequired: true } });
  });

  app.get("/jobs", async (request) => {
    const query = request.query as { organizationId?: string };
    return { data: await app.services.jobStore.list(query.organizationId) };
  });

  app.get("/jobs/:id", async (request) => {
    const { id } = request.params as { id: string };
    const job = await app.services.jobStore.get(id);
    if (!job) throw new AppError(404, "JOB_NOT_FOUND", "Job not found");
    return { data: job };
  });
};
