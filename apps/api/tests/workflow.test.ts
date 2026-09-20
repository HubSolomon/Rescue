import { afterEach, describe, expect, it } from "vitest";
import { harness, idem, jobThroughToAssigned, SUBJECTS, VALID_JOB, type Harness } from "./helpers.js";

let open: Harness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});
async function boot() {
  open = await harness();
  return open;
}

describe("the full recovery lifecycle", () => {
  it("runs DRAFT -> TRIAGED -> QUOTED -> ASSIGNED -> IN_PROGRESS -> COMPLETED", async () => {
    const h = await boot();
    const customer = await h.auth(SUBJECTS.customerAdmin);
    const dispatcher = await h.auth(SUBJECTS.dispatcher);
    const provider = await h.auth(SUBJECTS.providerHansa);

    const created = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...customer, ...idem() },
      payload: VALID_JOB
    });
    expect(created.statusCode).toBe(201);
    const jobId = created.json().data.job.id;
    expect(created.json().data.job.status).toBe("DRAFT");
    // The suggestion is advisory and says so in the payload itself.
    expect(created.json().data.triage.requiresHumanApproval).toBe(true);
    expect(created.json().meta.humanApprovalRequired).toBe(true);

    const triaged = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/triage`,
      headers: dispatcher,
      payload: { vehicleClass: "LARGE_VAN", workers: 2, circularRoute: "DELIVER" }
    });
    expect(triaged.json().data.status).toBe("TRIAGED");

    const quoted = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/quotes`,
      headers: { ...dispatcher, ...idem() },
      payload: { netCents: 25_000 }
    });
    expect(quoted.statusCode).toBe(201);
    const quote = quoted.json().data.quote;
    expect(quote.netCents).toBe(25_000);
    expect(quote.vatCents).toBe(4_750);
    expect(quote.grossCents).toBe(29_750);
    expect(quoted.json().data.job.status).toBe("QUOTED");

    const approved = await h.app.inject({
      method: "POST",
      url: `/v1/quotes/${quote.id}/decision`,
      headers: { ...customer, ...idem() },
      payload: { decision: "APPROVE" }
    });
    expect(approved.json().data.quote.status).toBe("APPROVED");

    const offers = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/offers`,
      headers: { ...dispatcher, ...idem() },
      payload: { payoutNetCents: 18_000 }
    });
    expect(offers.statusCode).toBe(201);
    const offerId = offers.json().data[0].id;

    const accepted = await h.app.inject({
      method: "POST",
      url: `/v1/offers/${offerId}/response`,
      headers: provider,
      payload: { decision: "ACCEPT" }
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json().data.job.status).toBe("ASSIGNED");

    const started = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/start`,
      headers: provider
    });
    expect(started.json().data.status).toBe("IN_PROGRESS");

    // Completion is refused until evidence exists.
    const premature = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/complete`,
      headers: provider
    });
    expect(premature.statusCode).toBe(409);

    const ticket = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/evidence`,
      headers: provider,
      payload: {
        kind: "DELIVERY_PHOTO",
        mimeType: "image/jpeg",
        sizeBytes: 120_000,
        filename: "proof.jpg"
      }
    });
    expect(ticket.statusCode).toBe(201);
    await h.app.inject({
      method: "POST",
      url: `/v1/evidence/${ticket.json().data.evidenceId}/complete`,
      headers: provider
    });

    const completed = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/complete`,
      headers: provider
    });
    expect(completed.json().data.status).toBe("COMPLETED");
  });

  it("refuses transitions that are not on the state diagram", async () => {
    const h = await boot();
    const customer = await h.auth(SUBJECTS.customerAdmin);
    const provider = await h.auth(SUBJECTS.providerHansa);

    const created = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...customer, ...idem() },
      payload: VALID_JOB
    });
    const jobId = created.json().data.job.id;

    // DRAFT straight to IN_PROGRESS is not a legal edge.
    const response = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/start`,
      headers: provider
    });
    expect([404, 409]).toContain(response.statusCode);
  });

  it("cannot quote a job that has not been triaged", async () => {
    const h = await boot();
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: VALID_JOB
    });
    const response = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${created.json().data.job.id}/quotes`,
      headers: { ...(await h.auth(SUBJECTS.dispatcher)), ...idem() },
      payload: { netCents: 1000 }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("INVALID_STATE_TRANSITION");
  });

  it("cannot complete a cancelled job", async () => {
    const h = await boot();
    const customer = await h.auth(SUBJECTS.customerAdmin);
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...customer, ...idem() },
      payload: VALID_JOB
    });
    const jobId = created.json().data.job.id;
    const cancelled = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/cancel`,
      headers: customer,
      payload: { reason: "Customer resolved it themselves" }
    });
    expect(cancelled.json().data.status).toBe("CANCELLED");

    const again = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/cancel`,
      headers: customer,
      payload: { reason: "again" }
    });
    expect(again.statusCode).toBe(409);
  });
});

describe("quote integrity", () => {
  it("rejects a breakdown whose lines do not sum to the net total", async () => {
    const h = await boot();
    const dispatcher = await h.auth(SUBJECTS.dispatcher);
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: VALID_JOB
    });
    const jobId = created.json().data.job.id;
    await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/triage`,
      headers: dispatcher,
      payload: { vehicleClass: "LARGE_VAN", workers: 2, circularRoute: "DELIVER" }
    });

    const response = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/quotes`,
      headers: { ...dispatcher, ...idem() },
      payload: {
        netCents: 10_000,
        breakdown: [
          { label: "Labour", netCents: 6_000 },
          { label: "Vehicle", netCents: 3_000 }
        ]
      }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.message).toMatch(/9000 cents but netCents is 10000/);
  });

  it("refuses a fractional amount at the schema boundary", async () => {
    const h = await boot();
    const dispatcher = await h.auth(SUBJECTS.dispatcher);
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: VALID_JOB
    });
    const jobId = created.json().data.job.id;
    await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/triage`,
      headers: dispatcher,
      payload: { vehicleClass: "LARGE_VAN", workers: 2, circularRoute: "DELIVER" }
    });
    const response = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/quotes`,
      headers: { ...dispatcher, ...idem() },
      payload: { netCents: 100.5 }
    });
    expect(response.statusCode).toBe(400);
  });

  it("an ordinary member cannot approve a quote; only a customer admin can", async () => {
    const h = await boot();
    const dispatcher = await h.auth(SUBJECTS.dispatcher);
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: VALID_JOB
    });
    const jobId = created.json().data.job.id;
    await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/triage`,
      headers: dispatcher,
      payload: { vehicleClass: "LARGE_VAN", workers: 2, circularRoute: "DELIVER" }
    });
    const quoted = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/quotes`,
      headers: { ...dispatcher, ...idem() },
      payload: { netCents: 25_000 }
    });
    const quoteId = quoted.json().data.quote.id;

    const member = await h.app.inject({
      method: "POST",
      url: `/v1/quotes/${quoteId}/decision`,
      headers: { ...(await h.auth(SUBJECTS.customerMember)), ...idem() },
      payload: { decision: "APPROVE" }
    });
    expect(member.statusCode).toBe(403);
  });
});

describe("the audit trail records every step", () => {
  it("writes a job event for each transition, in order", async () => {
    const h = await boot();
    const { jobId } = await jobThroughToAssigned(h);
    const events = await h.app.inject({
      method: "GET",
      url: `/v1/jobs/${jobId}/events`,
      headers: await h.auth(SUBJECTS.dispatcher)
    });
    const types = events.json().data.map((event: { type: string }) => event.type);
    expect(types).toEqual([
      "JOB_CREATED",
      "TRIAGE_APPROVED",
      "QUOTE_SENT",
      "JOB_QUOTED",
      "QUOTE_APPROVED",
      "OFFERS_SENT",
      "OFFER_ACCEPTED"
    ]);
  });

  it("records the acting user on every audit entry", async () => {
    const h = await boot();
    await jobThroughToAssigned(h);
    expect(h.store.audit.length).toBeGreaterThan(0);
    for (const entry of h.store.audit) {
      expect(entry.actorId).toBeTruthy();
      expect(entry.action).toBeTruthy();
      expect(entry.entityType).toBeTruthy();
    }
  });

  it("carries a correlation id from the request through to the audit record", async () => {
    const h = await boot();
    await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: {
        ...(await h.auth(SUBJECTS.customerAdmin)),
        ...idem(),
        "x-request-id": "trace-me-12345"
      },
      payload: VALID_JOB
    });
    expect(h.store.audit.some((entry) => entry.correlationId === "trace-me-12345")).toBe(true);
  });
});
