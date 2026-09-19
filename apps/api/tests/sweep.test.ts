import { afterEach, describe, expect, it } from "vitest";
import { MINUTE_MS } from "../src/lib/clock.js";
import { DispatchSweep } from "../src/lib/dispatch.js";
import {
  harness,
  idem,
  jobThroughToAssigned,
  jobThroughToQuoted,
  onboardEligibleProvider,
  PROVIDER_HANSA,
  PROVIDER_ROLAND,
  SUBJECTS,
  type Harness
} from "./helpers.js";

/**
 * The dispatch sweep.
 *
 * Before this existed an offer expired only in the eye of whoever was looking
 * at it: the row said PENDING, the UI drew "Abgelaufen", and the job sat
 * uncovered with nobody coming. These tests are mostly about the cases where
 * the sweep must do *nothing* -- those are the ones that would otherwise
 * create a second claimant on work that already has one.
 */

const SYSTEM = { userId: null, role: "DISPATCHER" as const, correlationId: "sweep-test" };

let open: Harness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});
async function boot(overrides: Parameters<typeof harness>[0] = {}): Promise<Harness> {
  open = await harness(overrides);
  return open;
}

function sweepFor(h: Harness, config?: Parameters<typeof DispatchSweep>[0] extends never ? never : { providersPerRound?: number; maxRounds?: number; offerTtlMinutes?: number }) {
  return new DispatchSweep({ store: h.store, clock: h.clock, config });
}

async function offerTo(h: Harness, jobId: string, minutes: number): Promise<void> {
  const response = await h.app.inject({
    method: "POST",
    url: `/v1/jobs/${jobId}/offers`,
    headers: { ...(await h.auth(SUBJECTS.dispatcher)), ...idem() },
    payload: { payoutNetCents: 18_000, expiresInMinutes: minutes, maxProviders: 1 }
  });
  expect(response.statusCode).toBe(201);
}

describe("expiry", () => {
  it("expires a lapsed offer and says which job it uncovered", async () => {
    const h = await boot();
    const { jobId } = await jobThroughToQuoted(h);
    await offerTo(h, jobId, 5);

    h.clock.advance(6 * MINUTE_MS);
    const { expired, jobIds } = await h.store.expireOffers(h.clock.now(), SYSTEM);
    expect(expired).toBe(1);
    expect(jobIds).toEqual([jobId]);
  });

  it("leaves a live offer alone", async () => {
    const h = await boot();
    const { jobId } = await jobThroughToQuoted(h);
    await offerTo(h, jobId, 60);

    h.clock.advance(10 * MINUTE_MS);
    expect((await h.store.expireOffers(h.clock.now(), SYSTEM)).expired).toBe(0);
  });
});

describe("automatic fallback", () => {
  it("offers the job to the next provider when the first round lapses", async () => {
    const h = await boot();
    const sweep = sweepFor(h, { providersPerRound: 1, maxRounds: 3 });
    await onboardEligibleProvider(h);
    const { jobId } = await jobThroughToQuoted(h);
    await offerTo(h, jobId, 5);

    const firstRound = await h.store.listOffersForJob(jobId);
    expect(firstRound).toHaveLength(1);

    h.clock.advance(6 * MINUTE_MS);
    const result = await sweep.run(SYSTEM);

    expect(result.expired).toBe(1);
    expect(result.reoffered).toEqual([jobId]);

    const offers = await h.store.listOffersForJob(jobId);
    expect(offers).toHaveLength(2);
    // A provider is never asked twice about the same job.
    expect(new Set(offers.map((offer) => offer.providerId)).size).toBe(2);
    // The payout carries over: raising it would be a pricing decision.
    expect(offers.at(-1)!.payoutNetCents).toBe(firstRound[0]!.payoutNetCents);
  });

  it("escalates instead of looping when nobody is left to ask", async () => {
    const h = await boot();
    const sweep = sweepFor(h, { providersPerRound: 5, maxRounds: 3 });
    const { jobId } = await jobThroughToQuoted(h);
    await offerTo(h, jobId, 5);

    h.clock.advance(6 * MINUTE_MS);
    const result = await sweep.run(SYSTEM);

    // The seed has one eligible provider for this job; the rest are excluded
    // for real reasons. With nobody new to ask, a human is told.
    expect(result.reoffered).toEqual([]);
    expect(result.escalated).toEqual([{ jobId, reason: "NO_ELIGIBLE_PROVIDER_LEFT" }]);

    const escalation = h.store.events.find((event) => event.type === "DISPATCH_ESCALATED");
    expect(escalation).toBeDefined();
    // Escalation is an event, not a transition: the job has not moved.
    const job = await h.store.findJob(jobId, { kind: "staff" });
    expect(job!.status).toBe("QUOTED");
  });

  it("stops after the configured number of rounds", async () => {
    const h = await boot();
    const sweep = sweepFor(h, { providersPerRound: 1, maxRounds: 1, offerTtlMinutes: 5 });
    await onboardEligibleProvider(h);
    const { jobId } = await jobThroughToQuoted(h);
    await offerTo(h, jobId, 5);

    h.clock.advance(6 * MINUTE_MS);
    await sweep.run(SYSTEM);
    h.clock.advance(6 * MINUTE_MS);
    const second = await sweep.run(SYSTEM);

    expect(second.reoffered).toEqual([]);
    expect(second.escalated.map((entry) => entry.reason)).toContain("MAX_ROUNDS_REACHED");
  });
});

describe("the sweep does nothing when doing nothing is correct", () => {
  it("skips a job somebody already accepted", async () => {
    const h = await boot();
    const sweep = sweepFor(h);
    const { jobId } = await jobThroughToAssigned(h);

    h.clock.advance(60 * MINUTE_MS);
    const result = await sweep.run(SYSTEM);

    expect(result.reoffered).toEqual([]);
    expect(result.escalated).toEqual([]);
    const job = await h.store.findJob(jobId, { kind: "staff" });
    expect(job!.status).toBe("ASSIGNED");
  });

  it("skips a job that still has a live offer out", async () => {
    const h = await boot();
    const sweep = sweepFor(h, { providersPerRound: 1 });
    const { jobId } = await jobThroughToQuoted(h);

    // Two rounds by hand: one short, one long. The short one lapses, the long
    // one is still outstanding, so nobody new should be asked.
    await offerTo(h, jobId, 5);
    h.clock.advance(1 * MINUTE_MS);
    await h.store.createOffers({
      jobId,
      providerIds: [PROVIDER_ROLAND],
      payoutNetCents: 18_000,
      expiresAt: new Date(h.clock.now().getTime() + 60 * MINUTE_MS),
      actor: SYSTEM
    });

    h.clock.advance(6 * MINUTE_MS);
    const result = await sweep.run(SYSTEM);
    expect(result.expired).toBe(1);
    expect(result.reoffered).toEqual([]);
    expect(result.escalated).toEqual([]);
  });

  it("skips a cancelled job", async () => {
    const h = await boot();
    const sweep = sweepFor(h);
    const { jobId } = await jobThroughToQuoted(h);
    await offerTo(h, jobId, 5);

    await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/cancel`,
      headers: await h.auth(SUBJECTS.dispatcher),
      payload: { reason: "Customer changed their mind" }
    });

    h.clock.advance(6 * MINUTE_MS);
    const result = await sweep.run(SYSTEM);
    expect(result.reoffered).toEqual([]);
    expect(result.escalated).toEqual([]);
  });

  it("running twice over the same state changes nothing the second time", async () => {
    const h = await boot();
    const sweep = sweepFor(h, { providersPerRound: 1 });
    const { jobId } = await jobThroughToQuoted(h);
    await offerTo(h, jobId, 5);

    h.clock.advance(6 * MINUTE_MS);
    await sweep.run(SYSTEM);
    const after = await h.store.listOffersForJob(jobId);

    const second = await sweep.run(SYSTEM);
    expect(second.expired).toBe(0);
    expect(second.reoffered).toEqual([]);
    expect(await h.store.listOffersForJob(jobId)).toHaveLength(after.length);
  });

  it("will not dispatch a job whose quote was never approved", async () => {
    const h = await boot();
    const sweep = sweepFor(h);
    // Offers cannot be made before approval, so this job has none; the sweep
    // must not invent a first round on its own.
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: (await import("./helpers.js")).VALID_JOB
    });
    const jobId = created.json().data.job.id as string;

    h.clock.advance(120 * MINUTE_MS);
    const result = await sweep.run(SYSTEM);
    expect(result.reoffered).toEqual([]);
    expect(await h.store.listOffersForJob(jobId)).toEqual([]);
  });
});

describe("the sweep's work reaches the outbox", () => {
  it("an expiry and an escalation both become messages", async () => {
    const h = await boot();
    const sweep = sweepFor(h, { providersPerRound: 5 });
    const { jobId } = await jobThroughToQuoted(h);
    await offerTo(h, jobId, 5);

    h.clock.advance(6 * MINUTE_MS);
    await sweep.run(SYSTEM);

    const topics = (await h.store.listOutbox({ jobId })).map((message) => message.topic);
    expect(topics).toContain("offer.expired");
    expect(topics).toContain("dispatch.escalated");
  });

  it("the system is recorded as the actor, not a person", async () => {
    const h = await boot();
    const sweep = sweepFor(h, { providersPerRound: 5 });
    const { jobId } = await jobThroughToQuoted(h);
    await offerTo(h, jobId, 5);

    h.clock.advance(6 * MINUTE_MS);
    await sweep.run(SYSTEM);

    const escalation = h.store.events.find((event) => event.type === "DISPATCH_ESCALATED");
    // Null, not a synthetic user: a fake person in the audit log is worse than
    // an honest absence.
    expect(escalation!.actorId).toBeNull();
    expect(PROVIDER_HANSA).toBeDefined();
  });
});
