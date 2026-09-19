import { afterEach, describe, expect, it } from "vitest";
import {
  harness,
  idem,
  jobThroughToQuoted,
  PROVIDER_HANSA,
  PROVIDER_ROLAND,
  SUBJECTS,
  type Harness
} from "./helpers.js";

/**
 * Provider self-managed availability.
 *
 * `status` is RESCUE's decision about the company; `acceptingWork` is the
 * company's statement about today. The tests below exist to keep those two
 * facts from collapsing into one: a provider must be able to pause and resume
 * itself without an administrator, and a dispatcher must be able to tell the
 * two situations apart in the exclusion reasons.
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

describe("a provider governs its own availability", () => {
  it("pauses and resumes itself", async () => {
    const h = await boot();

    const paused = await h.app.inject({
      method: "POST",
      url: `/v1/providers/${PROVIDER_HANSA}/availability`,
      headers: { ...(await h.auth(SUBJECTS.providerHansa)), ...idem() },
      payload: { acceptingWork: false, note: "Transporter in der Werkstatt" }
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().data.acceptingWork).toBe(false);
    expect(paused.json().data.availabilityNote).toBe("Transporter in der Werkstatt");

    const resumed = await h.app.inject({
      method: "POST",
      url: `/v1/providers/${PROVIDER_HANSA}/availability`,
      headers: { ...(await h.auth(SUBJECTS.providerHansa)), ...idem() },
      payload: { acceptingWork: true }
    });
    expect(resumed.json().data.acceptingWork).toBe(true);
    // A reason for a pause is meaningless once the pause is over.
    expect(resumed.json().data.availabilityNote).toBeNull();
  });

  it("cannot pause another provider", async () => {
    const h = await boot();
    const response = await h.app.inject({
      method: "POST",
      url: `/v1/providers/${PROVIDER_ROLAND}/availability`,
      headers: { ...(await h.auth(SUBJECTS.providerHansa)), ...idem() },
      payload: { acceptingWork: false }
    });
    // Another tenant's record is reported absent, never forbidden.
    expect(response.statusCode).toBe(404);
  });

  it("a customer cannot touch it at all", async () => {
    const h = await boot();
    const response = await h.app.inject({
      method: "POST",
      url: `/v1/providers/${PROVIDER_HANSA}/availability`,
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: { acceptingWork: false }
    });
    expect(response.statusCode).toBe(404);
  });

  it("does not let a provider vet itself into ACTIVE", async () => {
    const h = await boot();
    // The availability route accepts no status field, and /review is staff
    // only -- this is what keeps the eligibility gate meaningful.
    const review = await h.app.inject({
      method: "POST",
      url: `/v1/providers/${PROVIDER_HANSA}/review`,
      headers: { ...(await h.auth(SUBJECTS.providerHansa)), ...idem() },
      payload: { status: "ACTIVE", reason: "self-approval attempt" }
    });
    expect(review.statusCode).toBe(403);
  });

  it("rejects a note longer than the column allows", async () => {
    const h = await boot();
    const response = await h.app.inject({
      method: "POST",
      url: `/v1/providers/${PROVIDER_HANSA}/availability`,
      headers: { ...(await h.auth(SUBJECTS.providerHansa)), ...idem() },
      payload: { acceptingWork: false, note: "x".repeat(201) }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });
});

describe("dispatch sees availability separately from vetting", () => {
  it("excludes a paused provider with its own reason", async () => {
    const h = await boot();
    const { jobId } = await jobThroughToQuoted(h);

    const before = await h.app.inject({
      method: "GET",
      url: `/v1/jobs/${jobId}/eligible-providers`,
      headers: await h.auth(SUBJECTS.dispatcher)
    });
    const hansaBefore = before
      .json()
      .data.find((result: { providerId: string }) => result.providerId === PROVIDER_HANSA);
    expect(hansaBefore.eligible).toBe(true);

    await h.app.inject({
      method: "POST",
      url: `/v1/providers/${PROVIDER_HANSA}/availability`,
      headers: { ...(await h.auth(SUBJECTS.providerHansa)), ...idem() },
      payload: { acceptingWork: false, note: "Fahrer krank" }
    });

    const after = await h.app.inject({
      method: "GET",
      url: `/v1/jobs/${jobId}/eligible-providers`,
      headers: await h.auth(SUBJECTS.dispatcher)
    });
    const hansaAfter = after
      .json()
      .data.find((result: { providerId: string }) => result.providerId === PROVIDER_HANSA);
    expect(hansaAfter.eligible).toBe(false);
    expect(hansaAfter.reasons).toContain("PROVIDER_NOT_ACCEPTING_WORK");
    // Still vetted. Pausing is not a compliance event.
    expect(hansaAfter.reasons).not.toContain("PROVIDER_NOT_ACTIVE");
  });

  it("the provider becomes eligible again the moment it resumes", async () => {
    const h = await boot();
    const { jobId } = await jobThroughToQuoted(h);

    for (const acceptingWork of [false, true]) {
      await h.app.inject({
        method: "POST",
        url: `/v1/providers/${PROVIDER_HANSA}/availability`,
        headers: { ...(await h.auth(SUBJECTS.providerHansa)), ...idem() },
        payload: { acceptingWork }
      });
      const response = await h.app.inject({
        method: "GET",
        url: `/v1/jobs/${jobId}/eligible-providers`,
        headers: await h.auth(SUBJECTS.dispatcher)
      });
      const hansa = response
        .json()
        .data.find((result: { providerId: string }) => result.providerId === PROVIDER_HANSA);
      expect(hansa.eligible).toBe(acceptingWork);
    }
  });

  it("records the change in the audit log", async () => {
    const h = await boot();
    await h.app.inject({
      method: "POST",
      url: `/v1/providers/${PROVIDER_HANSA}/availability`,
      headers: { ...(await h.auth(SUBJECTS.providerHansa)), ...idem() },
      payload: { acceptingWork: false, note: "Fahrer krank" }
    });
    const entry = h.store.audit.find((row) => row.action === "PROVIDER_AVAILABILITY_CHANGED");
    expect(entry).toBeDefined();
    expect(entry?.entityId).toBe(PROVIDER_HANSA);
    expect(entry?.metadata).toMatchObject({ from: true, to: false, note: "Fahrer krank" });
  });
});
