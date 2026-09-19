import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createOffersSchema, fallbackSchema, offerStatusSchema, respondToOfferSchema } from "@rescue/contracts";
import { MINUTE_MS, type Clock } from "../lib/clock.js";
import { AppError, notFound } from "../lib/errors.js";
import type { MapsProvider } from "../lib/maps.js";
import { DispatchSweep, rankForJob } from "../lib/dispatch.js";
import { requireAuth, requireProvider, requireRole } from "../plugins/auth.js";
import type { IdempotencyRunner } from "../plugins/idempotency.js";
import type { Store, StoredOffer } from "../store/types.js";

export interface OfferRouteDeps {
  store: Store;
  idempotency: IdempotencyRunner;
  clock: Clock;
  sweep: DispatchSweep;
  maps: MapsProvider;
}

const jobIdParams = z.object({ id: z.string().uuid() });
const offerIdParams = z.object({ offerId: z.string().uuid() });

function publicOffer(offer: StoredOffer) {
  return {
    ...offer,
    expiresAt: offer.expiresAt.toISOString(),
    respondedAt: offer.respondedAt?.toISOString() ?? null,
    createdAt: offer.createdAt.toISOString()
  };
}

export const offerRoutes =
  (deps: OfferRouteDeps): FastifyPluginAsync =>
  async (app) => {
    /**
     * Who could do this job, and why the rest could not.
     *
     * Read-only and dispatcher-facing. Returns ineligible providers with
     * reasons too, so a short list is explainable rather than mysterious.
     */
    app.get("/jobs/:id/eligible-providers", async (request) => {
      const auth = requireRole(request, "DISPATCHER", "ADMIN");
      const { id } = jobIdParams.parse(request.params);
      const job = await deps.store.findJob(id, auth.scope);
      if (!job) throw notFound("Job");

      return { data: await rankForJob(deps.store, job, deps.clock.now(), deps.maps) };
    });

    /**
     * Fan an offer out to the eligible providers, best-ranked first.
     *
     * Eligibility is recomputed here rather than trusted from the earlier
     * read, so a provider suspended in between cannot be offered work.
     */
    app.post("/jobs/:id/offers", async (request, reply) => {
      const auth = requireRole(request, "DISPATCHER", "ADMIN");
      const { id } = jobIdParams.parse(request.params);
      const input = createOffersSchema.parse(request.body);

      const job = await deps.store.findJob(id, auth.scope);
      if (!job) throw notFound("Job");
      if (job.status !== "QUOTED") {
        throw new AppError(
          409,
          "INVALID_STATE_TRANSITION",
          "Offers can only be made for a quoted job"
        );
      }
      // No job is dispatched without a price the customer agreed to. See
      // docs/adr/0001-fallback-returns-to-quoted.md.
      const quotes = await deps.store.listQuotesForJob(job.id, auth.scope);
      if (!quotes.some((quote) => quote.status === "APPROVED")) {
        throw new AppError(
          409,
          "INVALID_STATE_TRANSITION",
          "The customer must approve a quote before providers are offered the job"
        );
      }

      const ranked = await rankForJob(deps.store, job, deps.clock.now(), deps.maps);
      const eligible = ranked.filter((result) => result.eligible).slice(0, input.maxProviders);
      if (eligible.length === 0) {
        throw new AppError(
          409,
          "NO_ELIGIBLE_PROVIDER",
          "No provider currently satisfies the eligibility rules for this job"
        );
      }

      return deps.idempotency.run({
        request,
        reply,
        organizationId: job.organizationId,
        body: request.body,
        work: async () => {
          const offers = await deps.store.createOffers({
            jobId: job.id,
            providerIds: eligible.map((result) => result.providerId),
            payoutNetCents: input.payoutNetCents,
            expiresAt: new Date(deps.clock.now().getTime() + input.expiresInMinutes * MINUTE_MS),
            actor: auth.actor
          });
          return {
            statusCode: 201,
            body: { data: offers.map(publicOffer), meta: { consideredProviders: ranked.length } }
          };
        }
      });
    });

    app.get("/jobs/:id/offers", async (request) => {
      const auth = requireRole(request, "DISPATCHER", "ADMIN");
      const { id } = jobIdParams.parse(request.params);
      const job = await deps.store.findJob(id, auth.scope);
      if (!job) throw notFound("Job");
      return { data: (await deps.store.listOffersForJob(id)).map(publicOffer) };
    });

    /** A provider's own open offers. Scoped to their provider, never all. */
    app.get("/offers", async (request) => {
      const auth = requireProvider(request);
      const query = z.object({ status: offerStatusSchema.optional() }).parse(request.query);
      const offers = await deps.store.listOffersForProvider({
        providerId: auth.providerId,
        status: query.status
      });
      return { data: offers.map(publicOffer) };
    });

    /**
     * Accept or decline. The accept path is the one race in the system that
     * really matters: two providers accepting the same job at the same instant
     * must produce exactly one assignment. The store makes it atomic, and the
     * database backs that with a partial unique index on active assignments.
     */
    app.post("/offers/:offerId/response", async (request) => {
      const auth = requireProvider(request);
      const { offerId } = offerIdParams.parse(request.params);
      const input = respondToOfferSchema.parse(request.body);

      if (input.decision === "DECLINE") {
        const offer = await deps.store.declineOffer({
          offerId,
          providerId: auth.providerId,
          reason: input.reason,
          actor: auth.actor
        });
        return { data: { offer: publicOffer(offer) } };
      }

      const result = await deps.store.acceptOffer({
        offerId,
        providerId: auth.providerId,
        now: deps.clock.now(),
        actor: auth.actor
      });
      return {
        data: {
          offer: publicOffer(result.offer),
          assignment: {
            ...result.assignment,
            acceptedAt: result.assignment.acceptedAt.toISOString(),
            completedAt: result.assignment.completedAt?.toISOString() ?? null
          },
          job: result.job
        }
      };
    });

    /**
     * Provider falls through. Releases the assignment and returns the job to
     * TRIAGED so it can be offered again.
     */
    app.post("/jobs/:id/fallback", async (request) => {
      const auth = requireRole(request, "PROVIDER_ADMIN", "DISPATCHER", "ADMIN");
      const { id } = jobIdParams.parse(request.params);
      const input = fallbackSchema.parse(request.body);

      if (!auth.isStaff) {
        const assignment = await deps.store.findActiveAssignment(id);
        if (!assignment || assignment.providerId !== auth.providerId) throw notFound("Job");
      }
      const job = await deps.store.fallbackAssignment({
        jobId: id,
        reason: input.reason,
        actor: auth.actor
      });
      return { data: job };
    });

    /**
     * Expiry sweep. Phase 4 moves this to a worker on a timer; exposing it as
     * an admin endpoint now keeps the behaviour testable and lets an operator
     * force a sweep.
     */
    app.post("/offers/expire", async (request) => {
      const auth = requireRole(request, "ADMIN");
      // The sweep does not only expire: a job whose last offer just lapsed is
      // uncovered, and covering it again is the point of running this.
      const result = await deps.sweep.run(auth.actor);
      return { data: result };
    });
  };
