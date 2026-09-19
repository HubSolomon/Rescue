import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createQuoteSchema, decideQuoteSchema, vatCents } from "@rescue/contracts";
import { HOUR_MS } from "../lib/clock.js";
import { AppError, notFound } from "../lib/errors.js";
import { requireAuth, requireOrganization, requireRole } from "../plugins/auth.js";
import type { IdempotencyRunner } from "../plugins/idempotency.js";
import type { Clock } from "../lib/clock.js";
import type { Store, StoredQuote } from "../store/types.js";

export interface QuoteRouteDeps {
  store: Store;
  idempotency: IdempotencyRunner;
  clock: Clock;
}

const jobIdParams = z.object({ id: z.string().uuid() });
const quoteIdParams = z.object({ quoteId: z.string().uuid() });

function publicQuote(quote: StoredQuote) {
  return {
    ...quote,
    validUntil: quote.validUntil.toISOString(),
    approvedAt: quote.approvedAt?.toISOString() ?? null,
    createdAt: quote.createdAt.toISOString()
  };
}

export const quoteRoutes =
  (deps: QuoteRouteDeps): FastifyPluginAsync =>
  async (app) => {
    /**
     * Price a job. Dispatcher-only: a customer cannot quote their own job.
     *
     * VAT is computed server-side from the net amount with integer arithmetic;
     * the client cannot submit gross or VAT figures, so it cannot submit an
     * internally inconsistent total. The database enforces the same invariant
     * with a CHECK constraint.
     */
    app.post("/jobs/:id/quotes", async (request, reply) => {
      const auth = requireRole(request, "DISPATCHER", "ADMIN");
      const { id } = jobIdParams.parse(request.params);
      const input = createQuoteSchema.parse(request.body);

      const job = await deps.store.findJob(id, auth.scope);
      if (!job) throw notFound("Job");
      if (job.status !== "TRIAGED") {
        throw new AppError(409, "INVALID_STATE_TRANSITION", "A job must be triaged before it can be quoted");
      }

      if (input.breakdown && input.breakdown.length > 0) {
        const total = input.breakdown.reduce((sum, line) => sum + line.netCents, 0);
        if (total !== input.netCents) {
          throw new AppError(
            400,
            "VALIDATION_ERROR",
            `Breakdown lines total ${total} cents but netCents is ${input.netCents}`
          );
        }
      }

      const vat = vatCents(input.netCents, input.vatRateBasisPoints);

      return deps.idempotency.run({
        request,
        reply,
        organizationId: job.organizationId,
        body: request.body,
        work: async () => {
          const quote = await deps.store.createQuote({
            jobId: job.id,
            organizationId: job.organizationId,
            netCents: input.netCents,
            vatCents: vat,
            grossCents: input.netCents + vat,
            vatRateBasisPoints: input.vatRateBasisPoints,
            breakdown: input.breakdown ?? null,
            notes: input.notes ?? null,
            validUntil: new Date(deps.clock.now().getTime() + input.validForHours * HOUR_MS),
            actor: auth.actor
          });
          const updated = await deps.store.transitionJob({
            jobId: job.id,
            scope: auth.scope,
            to: "QUOTED",
            actor: auth.actor,
            eventType: "JOB_QUOTED",
            payload: { quoteId: quote.id, grossCents: quote.grossCents }
          });
          return { statusCode: 201, body: { data: { quote: publicQuote(quote), job: updated } } };
        }
      });
    });

    app.get("/jobs/:id/quotes", async (request) => {
      const auth = requireAuth(request);
      const { id } = jobIdParams.parse(request.params);
      const quotes = await deps.store.listQuotesForJob(id, auth.scope);
      return { data: quotes.map(publicQuote) };
    });

    /**
     * The customer's decision. Restricted to CUSTOMER_ADMIN: accepting a
     * price is a financial commitment, so an ordinary member cannot make it.
     */
    app.post("/quotes/:quoteId/decision", async (request, reply) => {
      const auth = requireOrganization(request);
      requireRole(request, "CUSTOMER_ADMIN", "ADMIN");
      const { quoteId } = quoteIdParams.parse(request.params);
      const input = decideQuoteSchema.parse(request.body);

      return deps.idempotency.run({
        request,
        reply,
        organizationId: auth.organizationId,
        body: request.body,
        work: async () => {
          const { quote, job } = await deps.store.decideQuote({
            quoteId,
            scope: auth.scope,
            decision: input.decision,
            reason: input.reason,
            actor: auth.actor
          });
          return { statusCode: 200, body: { data: { quote: publicQuote(quote), job } } };
        }
      });
    });
  };
