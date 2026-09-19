import { z } from "zod";
import { isoDateTime, uuid } from "./common.js";

/**
 * Asynchronous operations: the outbox, and the ports the worker drives.
 *
 * The rule the whole phase rests on: a side effect is never performed inside
 * the transaction that caused it, and never fired from a route handler hoping
 * it lands. The state change and a durable record of the intent are written
 * together, atomically; a separate process turns intents into effects, with
 * retries and a dead letter. That is the only arrangement in which "the job
 * moved to ASSIGNED" and "the provider was told" cannot disagree.
 */

/* ------------------------------------------------------------------ outbox */

export const outboxTopics = [
  "job.created",
  "job.triaged",
  "job.quoted",
  "quote.decided",
  "offers.sent",
  "offer.accepted",
  "offer.declined",
  "offer.expired",
  "assignment.fell_through",
  "job.started",
  "job.completed",
  "job.cancelled",
  "dispatch.escalated",
  "payment.authorisation_requested",
  "payment.capture_requested",
  "payout.requested"
] as const;
export const outboxTopicSchema = z.enum(outboxTopics);
export type OutboxTopic = z.infer<typeof outboxTopicSchema>;

export const outboxStatuses = ["PENDING", "SENT", "FAILED", "DEAD"] as const;
export const outboxStatusSchema = z.enum(outboxStatuses);
export type OutboxStatus = z.infer<typeof outboxStatusSchema>;

export const outboxMessageSchema = z.object({
  id: uuid(),
  topic: outboxTopicSchema,
  /**
   * Stable across retries and across processes. Two attempts to enqueue the
   * same intent collapse into one row, which is what makes the whole pipeline
   * at-least-once at the edge and effectively-once in practice.
   */
  dedupeKey: z.string().min(1).max(200),
  jobId: uuid().nullable(),
  payload: z.record(z.string(), z.unknown()),
  status: outboxStatusSchema,
  attempts: z.number().int().min(0),
  /** Not claimable before this instant. Backoff is expressed by moving it. */
  availableAt: isoDateTime(),
  lastError: z.string().nullable(),
  createdAt: isoDateTime(),
  deliveredAt: isoDateTime().nullable()
});
export type OutboxMessage = z.infer<typeof outboxMessageSchema>;

/**
 * How long to wait before attempt n, in milliseconds.
 *
 * Exponential with a ceiling, and deliberately not jittered: with a single
 * worker jitter buys nothing, and a deterministic schedule is one a test can
 * assert on. Add jitter when there is more than one worker, not before.
 */
export const OUTBOX_MAX_ATTEMPTS = 5;
export function outboxBackoffMs(attempts: number): number {
  const base = 30_000;
  const ceiling = 30 * 60_000;
  return Math.min(ceiling, base * 2 ** Math.max(0, attempts - 1));
}

/* ----------------------------------------------------------- notifications */

export const notificationChannels = ["EMAIL", "SMS", "PUSH"] as const;
export const notificationChannelSchema = z.enum(notificationChannels);
export type NotificationChannel = z.infer<typeof notificationChannelSchema>;

export const notificationKinds = [
  "JOB_RECEIVED",
  "QUOTE_READY",
  "QUOTE_DECIDED",
  "OFFER_RECEIVED",
  "OFFER_WON",
  "OFFER_LOST",
  "JOB_STARTED",
  "JOB_COMPLETED",
  "JOB_CANCELLED",
  "DISPATCH_ESCALATION"
] as const;
export const notificationKindSchema = z.enum(notificationKinds);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

/* --------------------------------------------------------------- payments */

/**
 * The ledger is append-only and in integer cents, like everything else that
 * touches money. A balance is a fold over entries, never a column someone
 * updates -- a stored balance and an entry list can disagree, and when they do
 * neither is trustworthy.
 */
export const ledgerEntryKinds = [
  "AUTHORISATION",
  "AUTHORISATION_VOID",
  "CAPTURE",
  "REFUND",
  "PAYOUT",
  "PAYOUT_REVERSAL"
] as const;
export const ledgerEntryKindSchema = z.enum(ledgerEntryKinds);
export type LedgerEntryKind = z.infer<typeof ledgerEntryKindSchema>;

export const paymentStatuses = [
  "REQUIRES_AUTHORISATION",
  "AUTHORISED",
  "CAPTURED",
  "REFUNDED",
  "FAILED",
  "VOIDED"
] as const;
export const paymentStatusSchema = z.enum(paymentStatuses);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;

export const ledgerEntrySchema = z.object({
  id: uuid(),
  jobId: uuid(),
  kind: ledgerEntryKindSchema,
  /**
   * Signed, from RESCUE's point of view: money in from a customer is positive,
   * money out to a provider or back to a customer is negative. Summing the
   * column is therefore always meaningful.
   */
  amountCents: z.number().int(),
  currency: z.literal("EUR"),
  /** The provider's reference for this movement, where there is one. */
  externalReference: z.string().max(200).nullable(),
  note: z.string().max(500).nullable(),
  createdAt: isoDateTime()
});
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

/* ------------------------------------------------------------------- maps */

export const geocodeResultSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  /** How the coordinate was obtained, so a caller can judge it. */
  precision: z.enum(["ROOFTOP", "STREET", "POSTAL_CODE", "ESTIMATED"]),
  provider: z.string().max(60)
});
export type GeocodeResult = z.infer<typeof geocodeResultSchema>;

export const routeEstimateSchema = z.object({
  distanceKm: z.number().nonnegative(),
  durationMinutes: z.number().nonnegative(),
  /**
   * False when the numbers came from the offline fallback. The dispatcher UI
   * must say so: a guess presented as a road distance is worse than no number.
   */
  isRoadDistance: z.boolean(),
  provider: z.string().max(60)
});
export type RouteEstimate = z.infer<typeof routeEstimateSchema>;

/* --------------------------------------------------------------------- AI */

/**
 * Provenance for every model-produced suggestion.
 *
 * Stored alongside the suggestion itself, because six months from now the
 * only way to answer "why did it say that" is to know which prompt, which
 * version and which model produced it.
 */
export const suggestionProvenanceSchema = z.object({
  promptId: z.string().min(1).max(80),
  promptVersion: z.string().min(1).max(40),
  model: z.string().min(1).max(80),
  /** 0-1. Advisory metadata for a human, never a threshold that authorises. */
  confidence: z.number().min(0).max(1),
  /** Milliseconds the call took, for the cost and latency picture. */
  latencyMs: z.number().int().nonnegative(),
  /** True when the model was not reachable and a rules answer was used. */
  fellBackToRules: z.boolean(),
  generatedAt: isoDateTime()
});
export type SuggestionProvenance = z.infer<typeof suggestionProvenanceSchema>;

/**
 * Below this, the dispatcher console marks a suggestion as low confidence.
 * It changes what the human is told, and nothing else: no threshold anywhere
 * in this system causes or prevents a state change.
 */
export const LOW_CONFIDENCE_BELOW = 0.6;
