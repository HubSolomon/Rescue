import { afterEach, describe, expect, it } from "vitest";
import { summariseLedger, MockPaymentGateway } from "../src/lib/payments.js";
import { RecordingNotificationSender } from "../src/lib/notifications.js";
import { buildHandlers } from "../src/worker/handlers.js";
import { buildPaymentHandlers } from "../src/worker/payments.js";
import { composeHandlers, OutboxWorker } from "../src/worker/worker.js";
import {
  harness,
  idem,
  jobThroughToAssigned,
  jobThroughToQuoted,
  SUBJECTS,
  TEST_SECRET,
  type Harness
} from "./helpers.js";

/**
 * Money.
 *
 * Two things are being pinned. The arithmetic: integer cents, signed by
 * direction, and a balance that is always a fold rather than a column. And the
 * safety: at-least-once delivery means every payment handler will run twice
 * sooner or later, so running twice must not charge twice.
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

function workerFor(h: Harness): OutboxWorker {
  return new OutboxWorker({
    store: h.store,
    clock: h.clock,
    logger: h.app.log,
    handlers: composeHandlers(
      buildHandlers({ store: h.store, sender: new RecordingNotificationSender() }),
      buildPaymentHandlers({ store: h.store, gateway: new MockPaymentGateway(TEST_SECRET) })
    ),
    actor: { userId: null, role: "ADMIN" },
    batchSize: 50
  });
}

/** Drains until nothing is left, so a whole journey settles. */
async function settle(worker: OutboxWorker): Promise<void> {
  for (let pass = 0; pass < 5; pass++) {
    const result = await worker.drain();
    if (result.claimed === 0) return;
  }
}

describe("the ledger is a fold, not a balance", () => {
  it("sums entries by direction", () => {
    const entry = (kind: Parameters<typeof summariseLedger>[0][number]["kind"], amountCents: number) => ({
      id: kind,
      jobId: "j",
      kind,
      amountCents,
      currency: "EUR",
      externalReference: null,
      note: null,
      createdAt: new Date()
    });

    const summary = summariseLedger([
      entry("AUTHORISATION", 29_750),
      entry("CAPTURE", 29_750),
      entry("PAYOUT", -18_000),
      entry("REFUND", -5_000)
    ]);

    expect(summary.authorisedCents).toBe(29_750);
    expect(summary.capturedCents).toBe(29_750);
    expect(summary.paidOutCents).toBe(18_000);
    expect(summary.refundedCents).toBe(5_000);
    // What RESCUE is actually holding. The hold is not counted: it is not money.
    expect(summary.netCents).toBe(29_750 - 18_000 - 5_000);
  });

  it("a released hold stops counting as authorised", () => {
    const base = {
      jobId: "j",
      currency: "EUR",
      externalReference: null,
      note: null,
      createdAt: new Date()
    };
    const summary = summariseLedger([
      { ...base, id: "1", kind: "AUTHORISATION", amountCents: 29_750 },
      { ...base, id: "2", kind: "AUTHORISATION_VOID", amountCents: -29_750 }
    ]);
    expect(summary.authorisedCents).toBe(0);
    expect(summary.netCents).toBe(0);
  });
});

describe("the store refuses an entry whose sign disagrees with its kind", () => {
  it("a positive payout is rejected", async () => {
    const h = await boot();
    const { jobId } = await jobThroughToQuoted(h);
    await expect(
      h.store.appendLedgerEntries({
        entries: [{ jobId, kind: "PAYOUT", amountCents: 18_000 }],
        actor: { userId: null, role: "ADMIN" }
      })
    ).rejects.toThrow(/negative/i);
  });

  it("a zero entry is rejected", async () => {
    const h = await boot();
    const { jobId } = await jobThroughToQuoted(h);
    await expect(
      h.store.appendLedgerEntries({
        entries: [{ jobId, kind: "CAPTURE", amountCents: 0 }],
        actor: { userId: null, role: "ADMIN" }
      })
    ).rejects.toThrow(/cannot be zero/i);
  });
});

describe("money follows the job, through the outbox", () => {
  it("approving a quote places a hold for the gross amount", async () => {
    const h = await boot();
    const worker = workerFor(h);
    const { jobId } = await jobThroughToQuoted(h);

    await settle(worker);

    const entries = await h.store.listLedger(jobId, { kind: "staff" });
    const authorisation = entries.find((entry) => entry.kind === "AUTHORISATION");
    expect(authorisation).toBeDefined();
    // 250,00 net at 19% is 297,50 gross, and the customer is held for the
    // gross: VAT is money that moves too.
    expect(authorisation!.amountCents).toBe(29_750);
    expect(authorisation!.externalReference).toMatch(/^mock_auth_/);
  });

  it("completing captures the customer and pays the provider what they accepted", async () => {
    const h = await boot();
    const worker = workerFor(h);
    const { jobId } = await jobThroughToAssigned(h);
    const provider = await h.auth(SUBJECTS.providerHansa);

    await h.app.inject({ method: "POST", url: `/v1/jobs/${jobId}/start`, headers: provider });
    const ticket = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/evidence`,
      headers: provider,
      payload: { kind: "DELIVERY_PHOTO", mimeType: "image/png", sizeBytes: 2048, filename: "p.png" }
    });
    await h.app.inject({
      method: "POST",
      url: `/v1/evidence/${ticket.json().data.evidenceId}/complete`,
      headers: provider
    });
    await h.app.inject({ method: "POST", url: `/v1/jobs/${jobId}/complete`, headers: provider });

    await settle(worker);

    const entries = await h.store.listLedger(jobId, { kind: "staff" });
    const summary = summariseLedger(entries);
    expect(summary.capturedCents).toBe(29_750);
    // 180,00 is what the provider accepted, so 180,00 is what they are paid --
    // not a share recomputed here, which could differ from the agreement.
    expect(summary.paidOutCents).toBe(18_000);
    expect(summary.netCents).toBe(29_750 - 18_000);
  });

  it("cancelling before capture releases the hold", async () => {
    const h = await boot();
    const worker = workerFor(h);
    const { jobId } = await jobThroughToQuoted(h);
    await settle(worker);

    await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/cancel`,
      headers: await h.auth(SUBJECTS.dispatcher),
      payload: { reason: "Customer no longer needs the recovery" }
    });
    await settle(worker);

    const summary = summariseLedger(await h.store.listLedger(jobId, { kind: "staff" }));
    expect(summary.authorisedCents).toBe(0);
    expect(summary.capturedCents).toBe(0);
    expect(summary.netCents).toBe(0);
  });
});

describe("running twice does not charge twice", () => {
  it("re-delivering the same message adds no second entry", async () => {
    const h = await boot();
    const worker = workerFor(h);
    const { jobId } = await jobThroughToQuoted(h);
    await settle(worker);

    const before = await h.store.listLedger(jobId, { kind: "staff" });
    expect(before).toHaveLength(1);

    // Force the message back into the queue, as a crash between the handler
    // running and the row being marked delivered would.
    const message = (await h.store.listOutbox({ jobId })).find(
      (row) => row.topic === "quote.decided"
    )!;
    await h.store.markOutboxFailed({
      id: message.id,
      error: "simulated crash after the handler ran",
      now: h.clock.now(),
      retryAt: h.clock.now()
    });

    await settle(worker);
    const after = await h.store.listLedger(jobId, { kind: "staff" });
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before[0]!.id);
  });

  it("the gateway is idempotent on its own key", async () => {
    const gateway = new MockPaymentGateway(TEST_SECRET);
    const first = await gateway.authorise({
      jobId: "j1",
      amountCents: 1000,
      idempotencyKey: "auth:j1",
      description: "x"
    });
    const second = await gateway.authorise({
      jobId: "j1",
      amountCents: 1000,
      idempotencyKey: "auth:j1",
      description: "x"
    });
    expect(second.reference).toBe(first.reference);
  });
});

describe("the gateway refuses what a real one would refuse", () => {
  it("a capture larger than its authorisation", async () => {
    const gateway = new MockPaymentGateway(TEST_SECRET);
    const auth = await gateway.authorise({
      jobId: "j",
      amountCents: 1000,
      idempotencyKey: "k",
      description: "x"
    });
    await expect(gateway.capture({ reference: auth.reference, amountCents: 1500 })).rejects.toThrow(
      /exceed/i
    );
  });

  it("a capture against an authorisation that does not exist", async () => {
    const gateway = new MockPaymentGateway(TEST_SECRET);
    await expect(gateway.capture({ reference: "nope", amountCents: 100 })).rejects.toThrow(
      /no authorisation/i
    );
  });

  it("a fractional amount", async () => {
    const gateway = new MockPaymentGateway(TEST_SECRET);
    await expect(
      gateway.authorise({ jobId: "j", amountCents: 10.5, idempotencyKey: "k", description: "x" })
    ).rejects.toThrow(/whole number/i);
  });
});

describe("who may read the money", () => {
  it("a dispatcher may", async () => {
    const h = await boot();
    const worker = workerFor(h);
    const { jobId } = await jobThroughToQuoted(h);
    await settle(worker);

    const response = await h.app.inject({
      method: "GET",
      url: `/v1/jobs/${jobId}/ledger`,
      headers: await h.auth(SUBJECTS.dispatcher)
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().meta.authorisedCents).toBe(29_750);
  });

  it("a customer may not, and a provider may not", async () => {
    const h = await boot();
    const { jobId } = await jobThroughToQuoted(h);

    for (const subject of [SUBJECTS.customerAdmin, SUBJECTS.providerHansa]) {
      const response = await h.app.inject({
        method: "GET",
        url: `/v1/jobs/${jobId}/ledger`,
        headers: await h.auth(subject)
      });
      expect(response.statusCode).toBe(403);
    }
  });
});
