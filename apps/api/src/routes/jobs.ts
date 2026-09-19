import type { FastifyPluginAsync } from "fastify";
import {
  approveTriageSchema,
  cancelJobSchema,
  createJobSchema,
  jobStatusSchema,
  paginationQuerySchema
} from "@rescue/contracts";
import { z } from "zod";
import { AppError, notFound } from "../lib/errors.js";
import { requireAuth, requireOrganization, requireRole } from "../plugins/auth.js";
import type { IdempotencyRunner } from "../plugins/idempotency.js";
import type { Store } from "../store/types.js";
import type { TriageService } from "../lib/triage.js";

export interface JobRouteDeps {
  store: Store;
  triage: TriageService;
  idempotency: IdempotencyRunner;
}

const jobIdParams = z.object({ id: z.string().uuid() });

export const jobRoutes =
  (deps: JobRouteDeps): FastifyPluginAsync =>
  async (app) => {
    /**
     * Create a job.
     *
     * The owning organisation comes from `auth.organizationId`, which is
     * derived from the caller's memberships. The request body has no
     * organisation field at all -- see finding C2.
     */
    app.post("/jobs", async (request, reply) => {
      const auth = requireOrganization(request);
      requireRole(request, "CUSTOMER_ADMIN", "CUSTOMER_MEMBER", "DISPATCHER", "ADMIN");
      const input = createJobSchema.parse(request.body);

      return deps.idempotency.run({
        request,
        reply,
        organizationId: auth.organizationId,
        body: request.body,
        work: async () => {
          const job = await deps.store.createJob({
            organizationId: auth.organizationId,
            input,
            actor: auth.actor
          });
          const triage = await deps.triage.suggest(input);
          return {
            statusCode: 201,
            body: { data: { job, triage }, meta: { humanApprovalRequired: true } }
          };
        }
      });
    });

    /**
     * List jobs. Scope comes from the caller: a customer sees only their own
     * organisation's jobs, staff see all. There is no organisation parameter,
     * so the unparameterised full dump of finding C3 is not expressible.
     */
    app.get("/jobs", async (request) => {
      const auth = requireAuth(request);
      const query = paginationQuerySchema.extend({ status: jobStatusSchema.optional() }).parse(request.query);

      const page = await deps.store.listJobs({
        scope: auth.scope,
        status: query.status,
        limit: query.limit,
        cursor: query.cursor
      });
      return { data: page.items, meta: { nextCursor: page.nextCursor } };
    });

    /** A single job, or 404 when it belongs to another tenant (finding C4). */
    app.get("/jobs/:id", async (request) => {
      const auth = requireAuth(request);
      const { id } = jobIdParams.parse(request.params);
      const job = await deps.store.findJob(id, auth.scope);
      if (!job) throw notFound("Job");
      return { data: job };
    });

    /** The audit timeline for a job. */
    app.get("/jobs/:id/events", async (request) => {
      const auth = requireAuth(request);
      const { id } = jobIdParams.parse(request.params);
      const events = await deps.store.listJobEvents(id, auth.scope);
      return { data: events };
    });

    /**
     * Dispatcher approves the triage assessment and moves DRAFT -> TRIAGED.
     * This is the human decision the AI suggestion is not allowed to make.
     */
    app.post("/jobs/:id/triage", async (request, reply) => {
      const auth = requireRole(request, "DISPATCHER", "ADMIN");
      const { id } = jobIdParams.parse(request.params);
      const input = approveTriageSchema.parse(request.body);

      const job = await deps.store.transitionJob({
        jobId: id,
        scope: auth.scope,
        to: "TRIAGED",
        actor: auth.actor,
        eventType: "TRIAGE_APPROVED",
        payload: {
          vehicleClass: input.vehicleClass,
          workers: input.workers,
          circularRoute: input.circularRoute,
          dispatcherNotes: input.dispatcherNotes
        },
        approved: {
          vehicleClass: input.vehicleClass,
          workers: input.workers,
          circularRoute: input.circularRoute
        }
      });
      return reply.code(200).send({ data: job });
    });

    /** Provider marks work started: ASSIGNED -> IN_PROGRESS. */
    app.post("/jobs/:id/start", async (request) => {
      const auth = requireRole(request, "PROVIDER_ADMIN", "PROVIDER_DRIVER", "DISPATCHER", "ADMIN");
      const { id } = jobIdParams.parse(request.params);

      // A provider may only start a job it actually holds. The scope already
      // restricts them to jobs they are assigned to; this adds that it must be
      // the *current* assignment, not a past one.
      if (!auth.isStaff) {
        const assignment = await deps.store.findActiveAssignment(id);
        if (!assignment || assignment.providerId !== auth.providerId) throw notFound("Job");
      }
      const job = await deps.store.transitionJob({
        jobId: id,
        scope: auth.scope,
        to: "IN_PROGRESS",
        actor: auth.actor,
        eventType: "WORK_STARTED"
      });
      return { data: job };
    });

    /** Completion requires evidence to exist first; see routes/evidence.ts. */
    app.post("/jobs/:id/complete", async (request) => {
      const auth = requireRole(request, "PROVIDER_ADMIN", "PROVIDER_DRIVER", "DISPATCHER", "ADMIN");
      const { id } = jobIdParams.parse(request.params);

      if (!auth.isStaff) {
        const assignment = await deps.store.findActiveAssignment(id);
        if (!assignment || assignment.providerId !== auth.providerId) throw notFound("Job");
      }

      const evidence = await deps.store.listEvidence(id, auth.scope);
      const uploaded = evidence.filter((item) => item.status === "UPLOADED");
      if (uploaded.length === 0) {
        throw new AppError(409, "CONFLICT", "Upload proof of completion before completing the job");
      }

      const job = await deps.store.transitionJob({
        jobId: id,
        scope: auth.scope,
        to: "COMPLETED",
        actor: auth.actor,
        eventType: "JOB_COMPLETED",
        payload: { evidenceCount: uploaded.length }
      });
      return { data: job };
    });

    app.post("/jobs/:id/cancel", async (request) => {
      const auth = requireRole(request, "CUSTOMER_ADMIN", "DISPATCHER", "ADMIN");
      const { id } = jobIdParams.parse(request.params);
      const input = cancelJobSchema.parse(request.body);

      const job = await deps.store.transitionJob({
        jobId: id,
        scope: auth.scope,
        to: "CANCELLED",
        actor: auth.actor,
        eventType: "JOB_CANCELLED",
        payload: { reason: input.reason }
      });
      return { data: job };
    });
  };
