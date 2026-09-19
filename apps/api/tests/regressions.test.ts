import { afterEach, describe, expect, it } from "vitest";
import { harness, idem, ORG_WESERTECH, SUBJECTS, VALID_JOB, type Harness } from "./helpers.js";

/**
 * Regression tests for the Critical findings in docs/audits/FOUNDATION_AUDIT.md.
 *
 * Each test reproduces the exact request that worked before Phase 2 and
 * asserts it no longer does. If any of these start passing again, a tenant
 * boundary has been reopened.
 */

let open: Harness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

async function boot() {
  open = await harness();
  return open;
}

describe("C1 - no endpoint is reachable without authentication", () => {
  const protectedRoutes: [string, string][] = [
    ["POST", "/v1/jobs"],
    ["GET", "/v1/jobs"],
    ["GET", "/v1/jobs/11111111-1111-4111-8111-111111111111"],
    ["GET", "/v1/providers"],
    ["GET", "/v1/offers"],
    ["GET", "/v1/auth/me"]
  ];

  it.each(protectedRoutes)("%s %s answers 401 with no credentials", async (method, url) => {
    const h = await boot();
    const response = await h.app.inject({ method: method as "GET", url, payload: VALID_JOB });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("UNAUTHENTICATED");
  });

  it("rejects a token signed with the wrong key", async () => {
    const h = await boot();
    const { DevTokenIssuer } = await import("../src/lib/auth/verifier.js");
    const forged = await new DevTokenIssuer("a-different-secret-that-is-also-long-enough").issue(
      SUBJECTS.admin,
      3600
    );
    const response = await h.app.inject({
      method: "GET",
      url: "/v1/jobs",
      headers: { authorization: `Bearer ${forged.token}` }
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a valid token whose subject is not a known user", async () => {
    const h = await boot();
    const { DevTokenIssuer } = await import("../src/lib/auth/verifier.js");
    const stranger = await new DevTokenIssuer(h.config.JWT_SECRET).issue("dev|nobody", 3600);
    const response = await h.app.inject({
      method: "GET",
      url: "/v1/jobs",
      headers: { authorization: `Bearer ${stranger.token}` }
    });
    expect(response.statusCode).toBe(401);
  });

  it("still serves health without credentials", async () => {
    const h = await boot();
    expect((await h.app.inject({ method: "GET", url: "/v1/health" })).statusCode).toBe(200);
  });
});

describe("C2 - tenancy cannot be supplied by the client", () => {
  it("ignores organizationId in the request body", async () => {
    const h = await boot();
    const response = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      // The old exploit: name another tenant in the body.
      payload: { ...VALID_JOB, organizationId: ORG_WESERTECH }
    });
    expect(response.statusCode).toBe(201);
    // The job belongs to the caller's organisation, not the one they asked for.
    expect(response.json().data.job.organizationId).not.toBe(ORG_WESERTECH);
  });

  it("refuses an X-Organization-Id the caller is not a member of", async () => {
    const h = await boot();
    const response = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: {
        ...(await h.auth(SUBJECTS.customerAdmin)),
        ...idem(),
        "x-organization-id": ORG_WESERTECH
      },
      payload: VALID_JOB
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("FORBIDDEN");
  });
});

describe("C3 - listing cannot return other tenants' jobs", () => {
  it("an unparameterised list returns only the caller's organisation", async () => {
    const h = await boot();
    const nordlicht = await h.auth(SUBJECTS.customerAdmin);
    const weser = await h.auth(SUBJECTS.otherCustomer);

    await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...nordlicht, ...idem() },
      payload: { ...VALID_JOB, customerReference: "NORDLICHT-SECRET" }
    });
    await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...weser, ...idem() },
      payload: { ...VALID_JOB, customerReference: "WESER-SECRET" }
    });

    const response = await h.app.inject({ method: "GET", url: "/v1/jobs", headers: nordlicht });
    const references = response.json().data.map((job: { customerReference: string }) => job.customerReference);
    expect(references).toEqual(["NORDLICHT-SECRET"]);
    expect(references).not.toContain("WESER-SECRET");
  });

  it("an organizationId query parameter is inert", async () => {
    const h = await boot();
    const weser = await h.auth(SUBJECTS.otherCustomer);
    await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...weser, ...idem() },
      payload: { ...VALID_JOB, customerReference: "WESER-SECRET" }
    });

    // The old exploit: ask for another tenant by query string.
    const response = await h.app.inject({
      method: "GET",
      url: `/v1/jobs?organizationId=${ORG_WESERTECH}`,
      headers: await h.auth(SUBJECTS.customerAdmin)
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([]);
  });

  it("staff deliberately see across tenants", async () => {
    const h = await boot();
    await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: VALID_JOB
    });
    await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.otherCustomer)), ...idem() },
      payload: VALID_JOB
    });
    const response = await h.app.inject({
      method: "GET",
      url: "/v1/jobs",
      headers: await h.auth(SUBJECTS.dispatcher)
    });
    expect(response.json().data.length).toBe(2);
  });
});

describe("C4 - job detail is tenant-checked", () => {
  it("another tenant gets 404, not 403, and no payload", async () => {
    const h = await boot();
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: VALID_JOB
    });
    const jobId = created.json().data.job.id;

    const response = await h.app.inject({
      method: "GET",
      url: `/v1/jobs/${jobId}`,
      headers: await h.auth(SUBJECTS.otherCustomer)
    });

    // 404 rather than 403: a 403 would confirm the job exists.
    expect(response.statusCode).toBe(404);
    expect(JSON.stringify(response.json())).not.toContain("Gate code");
    expect(JSON.stringify(response.json())).not.toContain("Am Markt");
  });

  it("the owning tenant can still read it", async () => {
    const h = await boot();
    const customer = await h.auth(SUBJECTS.customerAdmin);
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...customer, ...idem() },
      payload: VALID_JOB
    });
    const jobId = created.json().data.job.id;
    const response = await h.app.inject({ method: "GET", url: `/v1/jobs/${jobId}`, headers: customer });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.notes).toBe("Gate code 4471.");
  });

  it("events are tenant-checked too", async () => {
    const h = await boot();
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: VALID_JOB
    });
    const jobId = created.json().data.job.id;
    const response = await h.app.inject({
      method: "GET",
      url: `/v1/jobs/${jobId}/events`,
      headers: await h.auth(SUBJECTS.otherCustomer)
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("role gates", () => {
  it("a customer cannot approve triage", async () => {
    const h = await boot();
    const customer = await h.auth(SUBJECTS.customerAdmin);
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...customer, ...idem() },
      payload: VALID_JOB
    });
    const jobId = created.json().data.job.id;
    const response = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/triage`,
      headers: customer,
      payload: { vehicleClass: "LARGE_VAN", workers: 2, circularRoute: "DELIVER" }
    });
    expect(response.statusCode).toBe(403);
  });

  it("a customer cannot quote their own job", async () => {
    const h = await boot();
    const customer = await h.auth(SUBJECTS.customerAdmin);
    const dispatcher = await h.auth(SUBJECTS.dispatcher);
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...customer, ...idem() },
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
      headers: { ...customer, ...idem() },
      payload: { netCents: 1 }
    });
    expect(response.statusCode).toBe(403);
  });

  it("a provider cannot activate itself", async () => {
    const h = await boot();
    const response = await h.app.inject({
      method: "POST",
      url: "/v1/providers/55555555-5555-4555-8555-555555555555/review",
      headers: await h.auth(SUBJECTS.providerHansa),
      payload: { status: "ACTIVE", reason: "self-approval attempt" }
    });
    expect(response.statusCode).toBe(403);
  });

  it("a provider cannot read another provider's fleet", async () => {
    const h = await boot();
    const response = await h.app.inject({
      method: "GET",
      url: "/v1/providers/44444444-4444-4444-8444-444444444444/vehicles",
      headers: await h.auth(SUBJECTS.providerHansa)
    });
    expect(response.statusCode).toBe(404);
  });
});
