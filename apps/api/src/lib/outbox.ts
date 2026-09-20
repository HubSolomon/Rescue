import { createHash } from "node:crypto";
import type { OutboxTopic } from "@rescue/contracts";

/**
 * Turning a job event into an outbox intent.
 *
 * The outbox is a projection of the event stream, not a second thing the
 * application has to remember to write. Every transition already records a
 * `JobEvent` inside its own transaction; this decides which of those the
 * outside world needs to hear about, and under what name. A transition that
 * nobody outside the system cares about produces no row, so the table stays a
 * work queue rather than a duplicate log.
 */

export interface OutboxDraft {
  topic: OutboxTopic;
  dedupeKey: string;
  jobId: string | null;
  payload: Record<string, unknown>;
}

/**
 * Event type to topic. Anything absent is internal.
 *
 * Kept as data rather than a switch so the set of things that leave the system
 * can be read in one glance -- and so adding a transition does not silently
 * add a notification.
 */
const TOPIC_BY_EVENT: Readonly<Record<string, OutboxTopic>> = {
  JOB_CREATED: "job.created",
  TRIAGE_APPROVED: "job.triaged",
  JOB_QUOTED: "job.quoted",
  // The store writes `QUOTE_${status}`, so both decisions are named here
  // rather than a single event that does not exist.
  QUOTE_APPROVED: "quote.decided",
  QUOTE_REJECTED: "quote.decided",
  OFFERS_SENT: "offers.sent",
  OFFER_ACCEPTED: "offer.accepted",
  OFFER_DECLINED: "offer.declined",
  OFFER_EXPIRED: "offer.expired",
  ASSIGNMENT_FELL_THROUGH: "assignment.fell_through",
  WORK_STARTED: "job.started",
  JOB_COMPLETED: "job.completed",
  JOB_CANCELLED: "job.cancelled",
  DISPATCH_ESCALATED: "dispatch.escalated"
};

/**
 * A key that is the same for the same intent and different for a different
 * one.
 *
 * Built from the topic, the job and the parts of the payload that identify the
 * occurrence -- never from a timestamp or a random value, or every retry would
 * look like a new intent and the provider would be told twice. Hashed so a key
 * cannot outgrow its column no matter how large the payload gets.
 */
export function dedupeKeyFor(
  topic: OutboxTopic,
  jobId: string | null,
  discriminator: readonly (string | number | null | undefined)[] = []
): string {
  const parts = [topic, jobId ?? "-", ...discriminator.map((part) => String(part ?? "-"))];
  const joined = parts.join("|");
  // Short keys stay readable in the table, which matters when someone is
  // looking at a stuck row at three in the morning.
  if (joined.length <= 180) return joined;
  return `${topic}|${jobId ?? "-"}|${createHash("sha256").update(joined).digest("hex").slice(0, 32)}`;
}

/**
 * The parts of a payload that identify *which* occurrence this is.
 *
 * `OFFER_EXPIRED` happens once per offer, so the offer id belongs in the key;
 * `JOB_COMPLETED` happens once per job, so the job id is enough. Getting this
 * wrong in the safe direction (too specific) means a duplicate notification;
 * getting it wrong in the other direction means a missing one, so where there
 * is doubt the identifier goes in.
 */
function discriminatorFor(type: string, payload: Record<string, unknown>): (string | number)[] {
  const take = (key: string): (string | number)[] => {
    const value = payload[key];
    return typeof value === "string" || typeof value === "number" ? [value] : [];
  };
  switch (type) {
    case "OFFERS_SENT":
      return take("round");
    case "OFFER_ACCEPTED":
    case "OFFER_DECLINED":
    case "OFFER_EXPIRED":
      return take("offerId");
    case "QUOTE_APPROVED":
    case "QUOTE_REJECTED":
      return take("quoteId");
    case "ASSIGNMENT_FELL_THROUGH":
      return take("assignmentId");
    case "DISPATCH_ESCALATED":
      return take("reason");
    default:
      return [];
  }
}

/** The outbox row a job event implies, or null when it implies none. */
export function outboxForEvent(params: {
  jobId: string;
  type: string;
  payload?: Record<string, unknown>;
}): OutboxDraft | null {
  const topic = TOPIC_BY_EVENT[params.type];
  if (!topic) return null;
  const payload = params.payload ?? {};
  return {
    topic,
    dedupeKey: dedupeKeyFor(topic, params.jobId, discriminatorFor(params.type, payload)),
    jobId: params.jobId,
    payload: { ...payload, eventType: params.type }
  };
}

/** Every event type that leaves the system, for tests and documentation. */
export const PUBLISHED_EVENT_TYPES = Object.freeze(Object.keys(TOPIC_BY_EVENT));
