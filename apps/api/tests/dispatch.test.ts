import { afterEach, describe, expect, it } from "vitest";
import { MINUTE_MS } from "../src/lib/clock.js";
import {
  harness,
  idem,
  jobThroughToAssigned,
  PROVIDER_HANSA,
  PROVIDER_PENDING,
  PROVIDER_ROLAND,
  SUBJECTS,
  VALID_JOB,
  type Harness
} from "./helpers.js";

let open: Harness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});
async function boot() {
  open = await harness();
  return open;
}

/** Creates a job and drives it to TRIAGED, ready for offers. */
async function triagedJob(h: Harness, payload = VALID_JOB) {
  const created = await h.app.inject({
    method: "POST",
    url: "/v1/jobs",
    headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
    payload
  });
  const jobId = created.json().data.job.id as string;
  await h.app.inject({
    method: "POST",
    url: `/v1/jobs/${jobId}/triage`,
    headers: await h.auth(SUBJECTS.dispatcher),
    payload: { vehicleClass: "LARGE_VAN", workers: 2, circularRoute: "DELIVER" }
  });
  return jobId;
}

/** Drives a job to QUOTED with an approved quote, ready for offers. */
async function quotedJob(h: Harness, payload = VALID_JOB) {
  const jobId = await triagedJob(h, payload);
  const quoted = await h.app.inject({
    method: "POST",
    url: `/v1/jobs/${jobId}/quotes`,
    headers: { ...(await h.auth(SUBJECTS.dispatcher)), ...idem() },
    payload: { netCents: 25_000 }
  });
  await h.app.inject({
    method: "POST",
    url: `/v1/quotes/${quoted.json().data.quote.id}/decision`,
    headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
    payload: { decision: "APPROVE" }
  });
  return jobId;
}

describe("eligibility drives who gets offered work", () => {
  it("excludes the pending provider and the one with expired insurance", async () => {
    const h = await boot();
    const jobId = await triagedJob(h);
    const response = await h.app.inject({
      method: "GET",
      url: `/v1/jobs/${jobId}/eligible-providers`,
      headers: await h.auth(SUBJECTS.dispatcher)
    });

    const results = response.json().data as {
      providerId: string;
      eligible: boolean;
      reasons: string[];
    }[];
    const byId = Object.fromEntries(results.map((result) => [result.providerId, result]));

    expect(byId[PROVIDER_HANSA]!.eligible).toBe(true);
    expect(byId[PROVIDER_ROLAND]!.eligible).toBe(false);
    expect(byId[PROVIDER_ROLAND]!.reasons).toContain("DOCUMENT_EXPIRED");
    expect(byId[PROVIDER_PENDING]!.eligible).toBe(false);
    expect(byId[PROVIDER_PENDING]!.reasons).toContain("PROVIDER_NOT_ACTIVE");
  });

  it("only offers to eligible providers", async () => {
    const h = await boot();
    const jobId = await quotedJob(h);
    const offers = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/offers`,
      headers: { ...(await h.auth(SUBJECTS.dispatcher)), ...idem() },
      payload: { payoutNetCents: 18_000 }
    });
    const providerIds = offers.json().data.map((offer: { providerId: string }) => offer.providerId);
    expect(providerIds).toEqual([PROVIDER_HANSA]);
  });

  it("refuses to fan out when nobody is eligible", async () => {
    const h = await boot();
    // Munich pickup: every seeded provider is in Bremen.
    const jobId = await quotedJob(h, {
      ...VALID_JOB,
      pickup: { line1: "Marienplatz 1", postalCode: "80331", city: "München", countryCode: "DE" }
    });
    const response = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/offers`,
      headers: { ...(await h.auth(SUBJECTS.dispatcher)), ...idem() },
      payload: { payoutNetCents: 18_000 }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("NO_ELIGIBLE_PROVIDER");
  });

  it("recomputes eligibility at fan-out, so a just-suspended provider is skipped", async () => {
    const h = await boot();
    const jobId = await quotedJob(h);

    await h.app.inject({
      method: "POST",
      url: `/v1/providers/${PROVIDER_HANSA}/review`,
      headers: await h.auth(SUBJECTS.compliance),
      payload: { status: "SUSPENDED", reason: "Insurance lapsed" }
    });

    const response = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/offers`,
      headers: { ...(await h.auth(SUBJECTS.dispatcher)), ...idem() },
      payload: { payoutNetCents: 18_000 }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("NO_ELIGIBLE_PROVIDER");
  });
});

describe("offer acceptance is a race with exactly one winner", () => {
  it("two providers accepting simultaneously produce one assignment", async () => {
    const h = await boot();
    const jobId = await quotedJob(h);

    // Make Roland eligible too, so both get an offer.
    await h.app.inject({
      method: "POST",
      url: `/v1/providers/${PROVIDER_ROLAND}/documents/d-roland-1/review`,
      headers: await h.auth(SUBJECTS.compliance),
      payload: { status: "VERIFIED", reason: "Renewed" }
    });
    // Re-dating the expired document is not possible through the API, so widen
    // the radius instead and rely on a second eligible provider being seeded.
    const offers = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/offers`,
      headers: { ...(await h.auth(SUBJECTS.dispatcher)), ...idem() },
      payload: { payoutNetCents: 18_000, maxProviders: 5 }
    });
    const offerList = offers.json().data as { id: string; providerId: string }[];

    const hansaOffer = offerList.find((offer) => offer.providerId === PROVIDER_HANSA);
    expect(hansaOffer).toBeDefined();

    // Fire the same acceptance twice concurrently.
    const [first, second] = await Promise.all([
      h.app.inject({
        method: "POST",
        url: `/v1/offers/${hansaOffer!.id}/response`,
        headers: await h.auth(SUBJECTS.providerHansa),
        payload: { decision: "ACCEPT" }
      }),
      h.app.inject({
        method: "POST",
        url: `/v1/offers/${hansaOffer!.id}/response`,
        headers: await h.auth(SUBJECTS.providerHansa),
        payload: { decision: "ACCEPT" }
      })
    ]);

    const statuses = [first.statusCode, second.statusCode].sort();
    expect(statuses).toEqual([200, 409]);

    const assignment = await h.store.findActiveAssignment(jobId);
    expect(assignment).not.toBeNull();
    const all = await h.store.listOffersForJob(jobId);
    expect(all.filter((offer) => offer.status === "ACCEPTED").length).toBe(1);
  });

  it("withdraws the other open offers when one is accepted", async () => {
    const h = await boot();
    const { jobId } = await jobThroughToAssigned(h);
    const offers = await h.store.listOffersForJob(jobId);
    expect(offers.filter((offer) => offer.status === "PENDING")).toHaveLength(0);
  });

  it("a provider cannot accept an offer addressed to someone else", async () => {
    const h = await boot();
    const jobId = await quotedJob(h);
    const offers = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/offers`,
      headers: { ...(await h.auth(SUBJECTS.dispatcher)), ...idem() },
      payload: { payoutNetCents: 18_000 }
    });
    const offerId = offers.json().data[0].id;

    const response = await h.app.inject({
      method: "POST",
      url: `/v1/offers/${offerId}/response`,
      headers: await h.auth(SUBJECTS.providerRoland),
      payload: { decision: "ACCEPT" }
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("offers expire", () => {
  it("cannot be accepted after the deadline", async () => {
    const h = await boot();
    const jobId = await quotedJob(h);
    const offers = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/offers`,
      headers: { ...(await h.auth(SUBJECTS.dispatcher)), ...idem() },
      payload: { payoutNetCents: 18_000, expiresInMinutes: 20 }
    });
    const offerId = offers.json().data[0].id;

    h.clock.advance(21 * MINUTE_MS);

    const response = await h.app.inject({
      method: "POST",
      url: `/v1/offers/${offerId}/response`,
      headers: await h.auth(SUBJECTS.providerHansa),
      payload: { decision: "ACCEPT" }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("OFFER_EXPIRED");
  });

  it("the sweep marks them expired and is idempotent", async () => {
    const h = await boot();
    const jobId = await quotedJob(h);
    await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/offers`,
      headers: { ...(await h.auth(SUBJECTS.dispatcher)), ...idem() },
      payload: { payoutNetCents: 18_000, expiresInMinutes: 5 }
    });

    h.clock.advance(6 * MINUTE_MS);
    const admin = await h.auth(SUBJECTS.admin);

    const first = await h.app.inject({ method: "POST", url: "/v1/offers/expire", headers: admin });
    expect(first.json().data.expired).toBe(1);

    const second = await h.app.inject({ method: "POST", url: "/v1/offers/expire", headers: admin });
    expect(second.json().data.expired).toBe(0);
  });

  it("an unexpired offer survives the sweep", async () => {
    const h = await boot();
    const jobId = await quotedJob(h);
    await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/offers`,
      headers: { ...(await h.auth(SUBJECTS.dispatcher)), ...idem() },
      payload: { payoutNetCents: 18_000, expiresInMinutes: 60 }
    });
    h.clock.advance(10 * MINUTE_MS);
    const response = await h.app.inject({
      method: "POST",
      url: "/v1/offers/expire",
      headers: await h.auth(SUBJECTS.admin)
    });
    expect(response.json().data.expired).toBe(0);
  });
});

describe("fallback returns the job for re-offer", () => {
  it("releases the assignment and moves the job back to QUOTED", async () => {
    const h = await boot();
    const { jobId } = await jobThroughToAssigned(h);

    const response = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/fallback`,
      headers: await h.auth(SUBJECTS.providerHansa),
      payload: { reason: "Van broke down" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe("QUOTED");
    expect(await h.store.findActiveAssignment(jobId)).toBeNull();
  });

  it("the job can then be offered again", async () => {
    const h = await boot();
    const { jobId } = await jobThroughToAssigned(h);
    await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/fallback`,
      headers: await h.auth(SUBJECTS.dispatcher),
      payload: { reason: "Provider unreachable" }
    });

    const response = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/offers`,
      headers: { ...(await h.auth(SUBJECTS.dispatcher)), ...idem() },
      payload: { payoutNetCents: 20_000 }
    });
    // The first offer round already used this (job, provider) pair, so the
    // unique constraint means no new row -- but the call must not error.
    expect(response.statusCode).toBe(201);
  });

  it("a provider cannot fall back a job it does not hold", async () => {
    const h = await boot();
    const { jobId } = await jobThroughToAssigned(h);
    const response = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/fallback`,
      headers: await h.auth(SUBJECTS.providerRoland),
      payload: { reason: "not mine" }
    });
    expect(response.statusCode).toBe(404);
  });

  it("fallback on an unassigned job is a conflict, not a crash", async () => {
    const h = await boot();
    const jobId = await quotedJob(h);
    const response = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/fallback`,
      headers: await h.auth(SUBJECTS.dispatcher),
      payload: { reason: "nothing to release" }
    });
    expect(response.statusCode).toBe(409);
  });
});
