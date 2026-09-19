import { afterEach, describe, expect, it } from "vitest";
import { harness, idem, SUBJECTS, VALID_JOB, type Harness } from "./helpers.js";

let open: Harness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});
async function boot() {
  open = await harness();
  return open;
}

describe("mutations require an Idempotency-Key", () => {
  it("refuses a job creation without one", async () => {
    const h = await boot();
    const response = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: await h.auth(SUBJECTS.customerAdmin),
      payload: VALID_JOB
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("refuses a blank key", async () => {
    const h = await boot();
    const response = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), "idempotency-key": "   " },
      payload: VALID_JOB
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("replaying a key returns the original response", () => {
  it("creates exactly one job for two identical requests", async () => {
    const h = await boot();
    const customer = await h.auth(SUBJECTS.customerAdmin);
    const key = idem();

    const first = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...customer, ...key },
      payload: VALID_JOB
    });
    const second = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...customer, ...key },
      payload: VALID_JOB
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json().data.job.id).toBe(first.json().data.job.id);
    expect(second.headers["idempotent-replay"]).toBe("true");

    const list = await h.app.inject({ method: "GET", url: "/v1/jobs", headers: customer });
    expect(list.json().data).toHaveLength(1);
  });

  it("is insensitive to key order in the body, which is the same request", async () => {
    const h = await boot();
    const customer = await h.auth(SUBJECTS.customerAdmin);
    const key = idem();

    const first = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...customer, ...key },
      payload: { type: VALID_JOB.type, urgency: VALID_JOB.urgency, ...VALID_JOB }
    });
    // Same fields, different declaration order.
    const reordered = Object.fromEntries(Object.entries(VALID_JOB).reverse());
    const second = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...customer, ...key },
      payload: reordered
    });

    expect(second.statusCode).toBe(first.statusCode);
    expect(second.json().data.job.id).toBe(first.json().data.job.id);
  });

  it("refuses a reused key with a different body", async () => {
    const h = await boot();
    const customer = await h.auth(SUBJECTS.customerAdmin);
    const key = idem();

    await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...customer, ...key },
      payload: VALID_JOB
    });
    const second = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...customer, ...key },
      payload: { ...VALID_JOB, customerReference: "DIFFERENT" }
    });

    // Serving the stored response here would return the wrong resource.
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });
});

describe("keys are scoped per organisation", () => {
  it("the same key in two tenants does not collide", async () => {
    const h = await boot();
    const key = idem();

    const nordlicht = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...key },
      payload: { ...VALID_JOB, customerReference: "NORDLICHT" }
    });
    const weser = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.otherCustomer)), ...key },
      payload: { ...VALID_JOB, customerReference: "WESER" }
    });

    expect(nordlicht.statusCode).toBe(201);
    expect(weser.statusCode).toBe(201);
    // Two distinct jobs, and neither tenant saw the other's response.
    expect(weser.json().data.job.id).not.toBe(nordlicht.json().data.job.id);
    expect(weser.json().data.job.customerReference).toBe("WESER");
  });
});

describe("keys expire", () => {
  it("a key past its TTL no longer replays", async () => {
    const h = await harness({ config: undefined });
    open = h;
    const customer = await h.auth(SUBJECTS.customerAdmin);
    const key = idem();

    const first = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...customer, ...key },
      payload: VALID_JOB
    });

    // Reach into the store and age the record past its expiry.
    const record = await h.store.findIdempotencyRecord(
      first.json().data.job.organizationId,
      key["idempotency-key"]!
    );
    expect(record).not.toBeNull();
    await h.store.saveIdempotencyRecord({ ...record!, expiresAt: new Date(Date.now() - 1000) });

    const second = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...customer, ...key },
      payload: VALID_JOB
    });
    expect(second.json().data.job.id).not.toBe(first.json().data.job.id);
  });
});
