import { afterEach, describe, expect, it } from "vitest";
import { OUTBOX_MAX_ATTEMPTS, outboxBackoffMs } from "@rescue/contracts";
import { MINUTE_MS } from "../src/lib/clock.js";
import { dedupeKeyFor, outboxForEvent } from "../src/lib/outbox.js";
import { RecordingNotificationSender } from "../src/lib/notifications.js";
import { buildHandlers } from "../src/worker/handlers.js";
import { OutboxWorker } from "../src/worker/worker.js";
import { harness, idem, jobThroughToQuoted, SUBJECTS, VALID_JOB, type Harness } from "./helpers.js";

/**
 * The outbox and the worker.
 *
 * Two properties matter more than the rest, and both are here: an intent is
 * written in the same breath as the state change that caused it, and a
 * delivery that fails is retried rather than lost. Everything else is
 * plumbing.
 */

let open: Harness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});
async function boot(): Promise<Harness> {
  open = await harness();
  return open;
}

function workerFor(h: Harness, sender: RecordingNotificationSender): OutboxWorker {
  return new OutboxWorker({
    store: h.store,
    clock: h.clock,
    logger: h.app.log,
    handlers: buildHandlers({ store: h.store, sender }),
    actor: { userId: null, role: "DISPATCHER", correlationId: "test" },
    batchSize: 50
  });
}

describe("an intent is written with the state change that caused it", () => {
  it("creating a job enqueues exactly one message", async () => {
    const h = await boot();
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: VALID_JOB
    });
    const jobId = created.json().data.job.id as string;

    const messages = await h.store.listOutbox({ jobId });
    expect(messages.map((message) => message.topic)).toEqual(["job.created"]);
    expect(messages[0]!.status).toBe("PENDING");
    expect(messages[0]!.attempts).toBe(0);
  });

  it("the whole journey leaves one message per notifiable step, in order", async () => {
    const h = await boot();
    const { jobThroughToAssigned } = await import("./helpers.js");
    const { jobId } = await jobThroughToAssigned(h);

    const topics = (await h.store.listOutbox({ jobId })).map((message) => message.topic);
    expect(topics).toEqual([
      "job.created",
      "job.triaged",
      "job.quoted",
      "quote.decided",
      "offers.sent",
      "offer.accepted"
    ]);
  });

  it("a refused transition enqueues nothing", async () => {
    const h = await boot();
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: VALID_JOB
    });
    const jobId = created.json().data.job.id as string;

    // DRAFT cannot go straight to completed.
    const refused = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/complete`,
      headers: await h.auth(SUBJECTS.dispatcher)
    });
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);

    const topics = (await h.store.listOutbox({ jobId })).map((message) => message.topic);
    expect(topics).toEqual(["job.created"]);
  });

  it("an internal event produces no message", () => {
    // Provider availability is real and audited, and nobody outside the system
    // needs an email about it.
    expect(outboxForEvent({ jobId: "j", type: "PROVIDER_AVAILABILITY_CHANGED" })).toBeNull();
    expect(outboxForEvent({ jobId: "j", type: "EVIDENCE_REQUESTED" })).toBeNull();
  });
});

describe("dedupe keys identify an intent, not an attempt", () => {
  it("the same occurrence produces the same key", () => {
    const a = outboxForEvent({ jobId: "j1", type: "OFFER_EXPIRED", payload: { offerId: "o1" } });
    const b = outboxForEvent({ jobId: "j1", type: "OFFER_EXPIRED", payload: { offerId: "o1" } });
    expect(a!.dedupeKey).toBe(b!.dedupeKey);
  });

  it("different occurrences of the same type do not collide", () => {
    const a = outboxForEvent({ jobId: "j1", type: "OFFER_EXPIRED", payload: { offerId: "o1" } });
    const b = outboxForEvent({ jobId: "j1", type: "OFFER_EXPIRED", payload: { offerId: "o2" } });
    expect(a!.dedupeKey).not.toBe(b!.dedupeKey);
  });

  it("a key never outgrows its column", () => {
    const key = dedupeKeyFor("job.created", "j".repeat(40), [("x".repeat(500))]);
    expect(key.length).toBeLessThanOrEqual(200);
  });
});

describe("the worker delivers, retries, and eventually gives up", () => {
  it("delivers a pending message once", async () => {
    const h = await boot();
    const sender = new RecordingNotificationSender();
    const worker = workerFor(h, sender);

    await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: VALID_JOB
    });

    const first = await worker.drain();
    expect(first.delivered).toBe(1);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.kind).toBe("JOB_RECEIVED");

    // A second pass has nothing to do: the message is SENT, not re-claimed.
    h.clock.advance(5 * MINUTE_MS);
    const second = await worker.drain();
    expect(second.claimed).toBe(0);
    expect(sender.sent).toHaveLength(1);
  });

  it("retries a failed delivery with backoff and then succeeds", async () => {
    const h = await boot();
    const sender = new RecordingNotificationSender();
    const worker = workerFor(h, sender);

    await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: VALID_JOB
    });

    sender.failNext = 1;
    const failed = await worker.drain();
    expect(failed.failed).toBe(1);
    expect(sender.sent).toHaveLength(0);

    const afterFailure = (await h.store.listOutbox({}))[0]!;
    expect(afterFailure.status).toBe("FAILED");
    expect(afterFailure.attempts).toBe(1);
    expect(afterFailure.lastError).toMatch(/unavailable/);

    // Not yet due: backoff means the retry waits.
    const tooSoon = await worker.drain();
    expect(tooSoon.claimed).toBe(0);

    h.clock.advance(outboxBackoffMs(1) + 1_000);
    const retried = await worker.drain();
    expect(retried.delivered).toBe(1);
    expect(sender.sent).toHaveLength(1);
  });

  it("stops after the final attempt and leaves a dead letter behind", async () => {
    const h = await boot();
    const sender = new RecordingNotificationSender();
    const worker = workerFor(h, sender);

    await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: VALID_JOB
    });

    sender.failNext = OUTBOX_MAX_ATTEMPTS;
    for (let attempt = 1; attempt <= OUTBOX_MAX_ATTEMPTS; attempt++) {
      await worker.drain();
      h.clock.advance(outboxBackoffMs(attempt) + 1_000);
    }

    const dead = (await h.store.listOutbox({ status: "DEAD" }))[0];
    expect(dead).toBeDefined();
    expect(dead!.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    // The row stays. A dead letter that deletes itself is a lost delivery
    // nobody can find afterwards.
    expect(dead!.lastError).toMatch(/unavailable/);

    // And it is not picked up again, however long we wait.
    h.clock.advance(24 * 60 * MINUTE_MS);
    expect((await worker.drain()).claimed).toBe(0);
  });

  it("a topic with no handler is finished rather than left to rot", async () => {
    const h = await boot();
    const sender = new RecordingNotificationSender();
    const worker = new OutboxWorker({
      store: h.store,
      clock: h.clock,
      logger: h.app.log,
      handlers: {},
      actor: { userId: null, role: "DISPATCHER" }
    });

    await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: VALID_JOB
    });

    const result = await worker.drain();
    expect(result.skipped).toBe(1);
    expect(sender.sent).toHaveLength(0);
    expect((await h.store.listOutbox({ status: "SENT" }))).toHaveLength(1);
  });

  it("a claimed message is not handed to a second worker at once", async () => {
    const h = await boot();
    await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: VALID_JOB
    });

    const now = h.clock.now();
    const first = await h.store.claimOutbox({ now, limit: 10 });
    const second = await h.store.claimOutbox({ now, limit: 10 });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
  });
});

describe("what the recipient is told", () => {
  it("a provider hears about the job it won, not the customer's price", async () => {
    const h = await boot();
    const sender = new RecordingNotificationSender();
    const worker = workerFor(h, sender);
    const { jobThroughToAssigned } = await import("./helpers.js");
    await jobThroughToAssigned(h);

    await worker.drain();
    const won = sender.sent.find((notification) => notification.kind === "OFFER_WON");
    expect(won).toBeDefined();
    expect(won!.to.name).toBe("Hansa Transport UG");
    // 250,00 is what the customer agreed; a provider's message must not carry it.
    expect(won!.body).not.toMatch(/250|297/);
  });

  it("the recipient comes from stored records, not from the payload", async () => {
    const h = await boot();
    const sender = new RecordingNotificationSender();
    const worker = workerFor(h, sender);
    const { jobId } = await jobThroughToQuoted(h);

    // A payload that tries to name its own audience.
    await h.store.recordJobEvent({
      jobId,
      type: "DISPATCH_ESCALATED",
      payload: { reason: "TEST", to: "attacker@example.com", email: "attacker@example.com" },
      actor: { userId: null, role: "DISPATCHER" }
    });

    await worker.drain();
    const escalation = sender.sent.find(
      (notification) => notification.kind === "DISPATCH_ESCALATION"
    );
    expect(escalation).toBeDefined();
    expect(escalation!.to.email).toBeNull();
    expect(JSON.stringify(escalation!.to)).not.toContain("attacker@example.com");
  });
});
