import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { requestEvidenceUploadSchema } from "@rescue/contracts";
import { notFound } from "../lib/errors.js";
import { assertUploadAllowed, type EvidenceStorage } from "../lib/storage.js";
import { requireAuth, requireRole } from "../plugins/auth.js";
import type { Clock } from "../lib/clock.js";
import type { Store, StoredEvidence } from "../store/types.js";

export interface EvidenceRouteDeps {
  store: Store;
  storage: EvidenceStorage;
  clock: Clock;
}

const jobIdParams = z.object({ id: z.string().uuid() });
const evidenceIdParams = z.object({ evidenceId: z.string().uuid() });

function publicEvidence(evidence: StoredEvidence) {
  return { ...evidence, createdAt: evidence.createdAt.toISOString() };
}

export const evidenceRoutes =
  (deps: EvidenceRouteDeps): FastifyPluginAsync =>
  async (app) => {
    /**
     * Request a signed upload slot.
     *
     * The API never accepts file bytes. It validates the declared type and
     * size against an allowlist, generates a server-side object key, and
     * returns a short-lived signed PUT. The client's filename is used for
     * nothing -- see `buildStorageKey`.
     */
    app.post("/jobs/:id/evidence", async (request, reply) => {
      const auth = requireRole(request, "PROVIDER_ADMIN", "PROVIDER_DRIVER", "DISPATCHER", "ADMIN");
      const { id } = jobIdParams.parse(request.params);
      const input = requestEvidenceUploadSchema.parse(request.body);

      // A provider may only attach evidence to a job it currently holds.
      if (!auth.isStaff) {
        const assignment = await deps.store.findActiveAssignment(id);
        if (!assignment || assignment.providerId !== auth.providerId) throw notFound("Job");
      }

      const job = await deps.store.findJob(id, auth.scope);
      if (!job) throw notFound("Job");

      // Validated again here even though the schema already checked, because
      // this function is the single chokepoint the storage layer trusts.
      assertUploadAllowed(input.mimeType, input.sizeBytes);

      const ticket = deps.storage.createUploadTicket({
        jobId: id,
        evidenceKind: input.kind,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        filename: input.filename,
        now: deps.clock.now()
      });

      const evidence = await deps.store.createEvidence({
        jobId: id,
        kind: input.kind,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
        storageKey: ticket.storageKey,
        actor: auth.actor
      });

      return reply.code(201).send({
        data: {
          evidenceId: evidence.id,
          uploadUrl: ticket.uploadUrl,
          storageKey: ticket.storageKey,
          method: "PUT",
          headers: ticket.headers,
          maxBytes: ticket.maxBytes,
          expiresAt: ticket.expiresAt.toISOString()
        }
      });
    });

    /**
     * Client confirms the PUT succeeded. Phase 4 replaces this with a storage
     * webhook plus a malware scan; until then the transition is explicit so
     * completion cannot be claimed against an evidence row that was only ever
     * requested.
     */
    app.post("/evidence/:evidenceId/complete", async (request) => {
      const auth = requireRole(request, "PROVIDER_ADMIN", "PROVIDER_DRIVER", "DISPATCHER", "ADMIN");
      const { evidenceId } = evidenceIdParams.parse(request.params);
      const evidence = await deps.store.markEvidenceUploaded({ evidenceId, actor: auth.actor });
      return { data: publicEvidence(evidence) };
    });

    app.get("/jobs/:id/evidence", async (request) => {
      const auth = requireAuth(request);
      const { id } = jobIdParams.parse(request.params);
      const evidence = await deps.store.listEvidence(id, auth.scope);
      return { data: evidence.map(publicEvidence) };
    });
  };
