import type { NotificationKind } from "@rescue/contracts";
import type { Notification, NotificationSender } from "../lib/notifications.js";
import type { Store, StoredOutboxMessage } from "../store/types.js";
import type { HandlerRegistry } from "./worker.js";

/**
 * What each topic means to the people involved.
 *
 * One handler shape for all of them, because the differences are copy and
 * audience, not mechanism. The audience is derived from the job, never taken
 * from the message payload: a payload is written by whatever caused the event
 * and must not be able to redirect a notification.
 */

export interface HandlerDeps {
  store: Store;
  sender: NotificationSender;
}

interface Template {
  kind: NotificationKind;
  audience: "customer" | "provider" | "dispatch";
  subject: string;
  body: (message: StoredOutboxMessage) => string;
}

const reference = (message: StoredOutboxMessage) =>
  typeof message.payload.customerReference === "string"
    ? message.payload.customerReference
    : (message.jobId ?? "").slice(0, 8);

const TEMPLATES: Partial<Record<StoredOutboxMessage["topic"], Template>> = {
  "job.created": {
    kind: "JOB_RECEIVED",
    audience: "customer",
    subject: "Ihre Anfrage ist eingegangen",
    body: (message) =>
      `Wir haben Ihre Rückholung ${reference(message)} erhalten. Die Disposition prüft sie und meldet sich mit einem Angebot.`
  },
  "job.quoted": {
    kind: "QUOTE_READY",
    audience: "customer",
    subject: "Ihr Angebot liegt vor",
    body: (message) => `Für ${reference(message)} liegt ein Angebot vor. Bitte prüfen und freigeben.`
  },
  "quote.decided": {
    kind: "QUOTE_DECIDED",
    audience: "dispatch",
    subject: "Angebot beantwortet",
    body: (message) =>
      `Der Kunde hat das Angebot zu ${reference(message)} beantwortet: ${String(message.payload.decision ?? "unbekannt")}.`
  },
  "offers.sent": {
    kind: "OFFER_RECEIVED",
    audience: "provider",
    subject: "Neuer Auftrag verfügbar",
    body: (message) =>
      `Ein Auftrag in Ihrem Einsatzgebiet ist verfügbar. Das Angebot verfällt automatisch, wenn es nicht angenommen wird.`
  },
  "offer.accepted": {
    kind: "OFFER_WON",
    audience: "provider",
    subject: "Auftrag angenommen",
    body: (message) => `Sie haben ${reference(message)} angenommen. Der Auftrag ist verbindlich.`
  },
  "offer.declined": {
    kind: "OFFER_LOST",
    audience: "dispatch",
    subject: "Angebot abgelehnt",
    body: (message) => `Ein Partner hat ${reference(message)} abgelehnt.`
  },
  "offer.expired": {
    kind: "OFFER_LOST",
    audience: "dispatch",
    subject: "Angebot verfallen",
    body: (message) => `Ein Angebot zu ${reference(message)} ist ohne Antwort verfallen.`
  },
  "assignment.fell_through": {
    kind: "DISPATCH_ESCALATION",
    audience: "dispatch",
    subject: "Partner ausgefallen",
    body: (message) => `Die Zuweisung zu ${reference(message)} wurde aufgelöst. Der Auftrag kann erneut vergeben werden.`
  },
  "job.started": {
    kind: "JOB_STARTED",
    audience: "customer",
    subject: "Abholung gestartet",
    body: (message) => `Der Partner hat die Abholung zu ${reference(message)} begonnen.`
  },
  "job.completed": {
    kind: "JOB_COMPLETED",
    audience: "customer",
    subject: "Auftrag abgeschlossen",
    body: (message) => `${reference(message)} ist abgeschlossen. Der Nachweis steht im Portal bereit.`
  },
  "job.cancelled": {
    kind: "JOB_CANCELLED",
    audience: "customer",
    subject: "Auftrag storniert",
    body: (message) => `${reference(message)} wurde storniert.`
  },
  "dispatch.escalated": {
    kind: "DISPATCH_ESCALATION",
    audience: "dispatch",
    subject: "Auftrag braucht eine Entscheidung",
    body: (message) =>
      `Die automatische Vergabe für ${reference(message)} ist beendet (${String(message.payload.reason ?? "unbekannt")}). Bitte manuell vergeben.`
  }
};

/**
 * Who hears about this.
 *
 * Resolved from stored records, not from the message. Dispatch has no single
 * address yet, so those go out with a null recipient and the development
 * sender logs them; a real deployment routes them to an on-call address.
 */
async function recipientFor(
  audience: Template["audience"],
  message: StoredOutboxMessage,
  store: Store
): Promise<Notification["to"]> {
  if (audience === "dispatch" || !message.jobId) {
    return { userId: null, email: null, name: "Disposition" };
  }
  if (audience === "provider") {
    const assignment = await store.findActiveAssignment(message.jobId);
    if (!assignment) return { userId: null, email: null, name: "Partner" };
    const provider = await store.findProvider(assignment.providerId);
    return {
      userId: null,
      email: provider?.contactEmail ?? null,
      name: provider?.legalName ?? "Partner"
    };
  }
  // Customer. The organisation is the addressee; per-user routing is a Phase 5
  // concern once notification preferences exist.
  const job = await store.findJob(message.jobId, { kind: "staff" });
  return { userId: null, email: null, name: job ? job.organizationId : "Kunde" };
}

export function buildHandlers(deps: HandlerDeps): HandlerRegistry {
  const registry: HandlerRegistry = {};
  for (const [topic, template] of Object.entries(TEMPLATES)) {
    registry[topic as StoredOutboxMessage["topic"]] = async (message) => {
      const to = await recipientFor(template.audience, message, deps.store);
      await deps.sender.send({
        kind: template.kind,
        channel: "EMAIL",
        to,
        subject: template.subject,
        body: template.body(message),
        jobId: message.jobId
      });
    };
  }
  return registry;
}

/** The topics that currently produce a notification, for tests. */
export const NOTIFIED_TOPICS = Object.freeze(Object.keys(TEMPLATES));
