import { afterEach, describe, expect, it } from "vitest";
import { harness, idem, SUBJECTS, VALID_JOB, type Harness } from "./helpers.js";

/**
 * Smoke tests for the application shell: health, envelopes, correlation ids
 * and the not-found handler. Domain behaviour lives in the focused suites.
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

describe("application shell", () => {
  it("reports health without credentials", async () => {
    const h = await boot();
    const response = await h.app.inject({ method: "GET", url: "/v1/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("ok");
  });

  it("reports readiness with a dependency check", async () => {
    const h = await boot();
    const response = await h.app.inject({ method: "GET", url: "/v1/ready" });
    expect(response.statusCode).toBe(200);
    expect(response.json().checks.store).toBe("ok");
  });

  it("creates a job and returns an advisory triage suggestion", async () => {
    const h = await boot();
    const response = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: VALID_JOB
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data.job.status).toBe("DRAFT");
    expect(response.json().data.triage.requiresHumanApproval).toBe(true);
  });

  it("rejects an invalid German postal code", async () => {
    const h = await boot();
    const response = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: { ...VALID_JOB, pickup: { ...VALID_JOB.pickup, postalCode: "28" } }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("returns field paths in validation errors but not the submitted values", async () => {
    const h = await boot();
    const response = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: { ...VALID_JOB, pickup: { ...VALID_JOB.pickup, postalCode: "SECRET-VALUE" } }
    });
    const body = JSON.stringify(response.json());
    expect(body).toContain("pickup.postalCode");
    // The rejected input is not echoed back (finding L3).
    expect(body).not.toContain("SECRET-VALUE");
  });

  it("answers 401 before 404, so anonymous callers cannot map the route table", async () => {
    const h = await boot();
    const response = await h.app.inject({ method: "GET", url: "/v1/nope" });
    // Returning 404 here would tell an unauthenticated prober which paths
    // exist. Authentication is checked first, on purpose.
    expect(response.statusCode).toBe(401);
  });

  it("uses the documented error envelope for unknown routes once authenticated", async () => {
    const h = await boot();
    const response = await h.app.inject({
      method: "GET",
      url: "/v1/nope",
      headers: await h.auth(SUBJECTS.dispatcher)
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("NOT_FOUND");
  });

  it("echoes a correlation id back on every response", async () => {
    const h = await boot();
    const response = await h.app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { "x-request-id": "corr-123" }
    });
    expect(response.headers["x-request-id"]).toBe("corr-123");
  });

  it("generates a correlation id when the client does not send one", async () => {
    const h = await boot();
    const response = await h.app.inject({ method: "GET", url: "/v1/health" });
    expect(response.headers["x-request-id"]).toBeTruthy();
  });
});
