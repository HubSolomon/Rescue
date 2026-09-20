import { ENTRY_FOR, type PaymentGateway } from "../lib/payments.js";
import type { Store, StoredOutboxMessage } from "../store/types.js";
import type { HandlerRegistry } from "./worker.js";

/**
 * Money, driven from the outbox.
 *
 * Three moments, each triggered by a state change that already happened:
 *
 *   quote approved  -> authorise the customer
 *   job completed   -> capture, then pay the provider
 *   job cancelled   -> release the hold
 *
 * None of them runs inside the request that caused it. A card authorisation
 * that takes four seconds must not make the customer's "approve" button take
 * four seconds, and a gateway timeout must not roll back the approval itself.
 * Retries come free from the worker; the gateway calls are idempotent on a key
 * derived from the job, so a retry re-reads a charge rather than making a
 * second one.
 *
 * Every handler is written to be safe to run twice, because at-least-once
 * delivery means it will be. The guard is the ledger: if the entry this
 * handler would write is already there, the work is done.
 */

export interface PaymentHandlerDeps {
  store: Store;
  gateway: PaymentGateway;
  /** Share of the customer's net price that goes to the provider. */
  providerShare?: number;
}

const DEFAULT_PROVIDER_SHARE = 0.72;

/** True when this job already has an entry of this kind. */
async function alreadyRecorded(
  store: Store,
  jobId: string,
  kind: (typeof ENTRY_FOR)[keyof typeof ENTRY_FOR]["kind"]
): Promise<boolean> {
  const entries = await store.listLedger(jobId, { kind: "staff" });
  return entries.some((entry) => entry.kind === kind);
}

async function approvedNetCents(store: Store, jobId: string): Promise<number | null> {
  const quotes = await store.listQuotesForJob(jobId, { kind: "staff" });
  const approved = quotes.find((quote) => quote.status === "APPROVED");
  return approved ? approved.grossCents : null;
}

export function buildPaymentHandlers(deps: PaymentHandlerDeps): HandlerRegistry {
  const share = deps.providerShare ?? DEFAULT_PROVIDER_SHARE;

  const authorise = async (message: StoredOutboxMessage) => {
    const jobId = message.jobId;
    if (!jobId) return;
    // A rejection is also a decision; only an approval takes money.
    if (message.payload.eventType !== "QUOTE_APPROVED") return;
    if (await alreadyRecorded(deps.store, jobId, "AUTHORISATION")) return;

    const gross = await approvedNetCents(deps.store, jobId);
    if (gross === null) return;

    const result = await deps.gateway.authorise({
      jobId,
      amountCents: gross,
      // Derived from the job, so a retry is the same charge at the gateway.
      idempotencyKey: `auth:${jobId}`,
      description: `RESCUE recovery ${jobId.slice(0, 8)}`
    });

    await deps.store.appendLedgerEntries({
      entries: [
        {
          jobId,
          kind: ENTRY_FOR.authorise.kind,
          amountCents: gross,
          externalReference: result.reference,
          note: "Hold placed when the customer approved the quote"
        }
      ],
      actor: { userId: null, role: "ADMIN", correlationId: `outbox:${message.id}` }
    });
  };

  const captureAndPay = async (message: StoredOutboxMessage) => {
    const jobId = message.jobId;
    if (!jobId) return;

    const entries = await deps.store.listLedger(jobId, { kind: "staff" });
    const authorisation = entries.find((entry) => entry.kind === "AUTHORISATION");
    // No hold means the quote was never approved through the normal path.
    // Leave it: inventing a charge here would be worse than a missing one.
    if (!authorisation) return;

    if (!entries.some((entry) => entry.kind === "CAPTURE")) {
      const captured = await deps.gateway.capture({
        reference: authorisation.externalReference ?? `auth:${jobId}`,
        amountCents: authorisation.amountCents
      });
      await deps.store.appendLedgerEntries({
        entries: [
          {
            jobId,
            kind: ENTRY_FOR.capture.kind,
            amountCents: authorisation.amountCents,
            externalReference: captured.reference,
            note: "Captured on completion, against proof of delivery"
          }
        ],
        actor: { userId: null, role: "ADMIN", correlationId: `outbox:${message.id}` }
      });
    }

    if (entries.some((entry) => entry.kind === "PAYOUT")) return;
    const assignment = await deps.store.findActiveAssignment(jobId);
    if (!assignment) return;

    // The payout is what the provider was offered, not a share computed here:
    // the offer is the agreement, and recomputing it could pay a different
    // number from the one the provider accepted.
    const offers = await deps.store.listOffersForJob(jobId);
    const accepted = offers.find((offer) => offer.status === "ACCEPTED");
    const payoutCents = accepted?.payoutNetCents ?? Math.round(authorisation.amountCents * share);

    const paid = await deps.gateway.payout({
      providerId: assignment.providerId,
      jobId,
      amountCents: payoutCents,
      idempotencyKey: `payout:${jobId}:${assignment.providerId}`
    });
    await deps.store.appendLedgerEntries({
      entries: [
        {
          jobId,
          kind: ENTRY_FOR.payout.kind,
          amountCents: -payoutCents,
          externalReference: paid.reference,
          note: `Payout to the provider that completed the work`
        }
      ],
      actor: { userId: null, role: "ADMIN", correlationId: `outbox:${message.id}` }
    });
  };

  const release = async (message: StoredOutboxMessage) => {
    const jobId = message.jobId;
    if (!jobId) return;
    const entries = await deps.store.listLedger(jobId, { kind: "staff" });
    const authorisation = entries.find((entry) => entry.kind === "AUTHORISATION");
    if (!authorisation) return;
    // Already captured: a cancellation after the money was taken is a refund
    // decision for a person, not something to do automatically.
    if (entries.some((entry) => entry.kind === "CAPTURE")) return;
    if (entries.some((entry) => entry.kind === "AUTHORISATION_VOID")) return;

    await deps.store.appendLedgerEntries({
      entries: [
        {
          jobId,
          kind: ENTRY_FOR.void.kind,
          amountCents: -authorisation.amountCents,
          externalReference: authorisation.externalReference,
          note: "Hold released when the job was cancelled"
        }
      ],
      actor: { userId: null, role: "ADMIN", correlationId: `outbox:${message.id}` }
    });
  };

  return {
    "quote.decided": authorise,
    "job.completed": captureAndPay,
    "job.cancelled": release
  };
}
