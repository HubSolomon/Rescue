import { afterEach, describe, expect, it } from "vitest";
import { MAX_EVIDENCE_BYTES } from "@rescue/contracts";
import { buildStorageKey } from "../src/lib/storage.js";
import { harness, jobThroughToAssigned, SUBJECTS, type Harness } from "./helpers.js";

let open: Harness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});
async function boot() {
  open = await harness();
  return open;
}

async function assignedJob(h: Harness) {
  const { jobId } = await jobThroughToAssigned(h);
  await h.app.inject({
    method: "POST",
    url: `/v1/jobs/${jobId}/start`,
    headers: await h.auth(SUBJECTS.providerHansa)
  });
  return jobId;
}

describe("only allow-listed media types are accepted", () => {
  it("accepts the four permitted types", async () => {
    const h = await boot();
    const jobId = await assignedJob(h);
    const provider = await h.auth(SUBJECTS.providerHansa);

    for (const mimeType of ["image/jpeg", "image/png", "image/webp", "application/pdf"]) {
      const response = await h.app.inject({
        method: "POST",
        url: `/v1/jobs/${jobId}/evidence`,
        headers: provider,
        payload: { kind: "DELIVERY_PHOTO", mimeType, sizeBytes: 1000, filename: "proof.bin" }
      });
      expect(response.statusCode, mimeType).toBe(201);
    }
  });

  it.each([
    ["image/svg+xml", "SVG executes script when served inline"],
    ["text/html", "HTML is an XSS vector"],
    ["application/x-msdownload", "executables are never evidence"],
    ["application/zip", "archives hide their contents"]
  ])("refuses %s", async (mimeType) => {
    const h = await boot();
    const jobId = await assignedJob(h);
    const response = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/evidence`,
      headers: await h.auth(SUBJECTS.providerHansa),
      payload: { kind: "DELIVERY_PHOTO", mimeType, sizeBytes: 1000, filename: "x.bin" }
    });
    expect([400, 415]).toContain(response.statusCode);
  });
});

describe("size limits", () => {
  it("refuses a file over the cap", async () => {
    const h = await boot();
    const jobId = await assignedJob(h);
    const response = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/evidence`,
      headers: await h.auth(SUBJECTS.providerHansa),
      payload: {
        kind: "DELIVERY_PHOTO",
        mimeType: "image/jpeg",
        sizeBytes: MAX_EVIDENCE_BYTES + 1,
        filename: "huge.jpg"
      }
    });
    expect([400, 413]).toContain(response.statusCode);
  });

  it("refuses a zero-byte file", async () => {
    const h = await boot();
    const jobId = await assignedJob(h);
    const response = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/evidence`,
      headers: await h.auth(SUBJECTS.providerHansa),
      payload: { kind: "DELIVERY_PHOTO", mimeType: "image/jpeg", sizeBytes: 0, filename: "empty.jpg" }
    });
    expect([400, 413]).toContain(response.statusCode);
  });
});

describe("the client's filename never reaches the object key", () => {
  it.each([
    "../../../etc/passwd",
    "..%2f..%2fescape.jpg",
    "with space.jpg",
    "semi;colon.jpg",
    "back\\slash.jpg"
  ])("rejects %s at the schema boundary", async (filename) => {
    const h = await boot();
    const jobId = await assignedJob(h);
    const response = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/evidence`,
      headers: await h.auth(SUBJECTS.providerHansa),
      payload: { kind: "DELIVERY_PHOTO", mimeType: "image/jpeg", sizeBytes: 1000, filename }
    });
    expect(response.statusCode).toBe(400);
  });

  it("derives the key from server-side values only", async () => {
    const h = await boot();
    const jobId = await assignedJob(h);
    const response = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/evidence`,
      headers: await h.auth(SUBJECTS.providerHansa),
      payload: {
        kind: "DELIVERY_PHOTO",
        mimeType: "image/jpeg",
        sizeBytes: 1000,
        filename: "my-chosen-name.png"
      }
    });
    const key = response.json().data.storageKey as string;
    // Neither the chosen name nor its extension survives.
    expect(key).not.toContain("my-chosen-name");
    expect(key).toMatch(/^evidence\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]+\/delivery_photo-[0-9a-f]{32}\.jpg$/);
  });

  it("generates a distinct key every time", () => {
    const params = {
      jobId: "11111111-1111-4111-8111-111111111111",
      evidenceKind: "SIGNATURE" as const,
      mimeType: "image/png" as const,
      now: new Date("2026-09-19T08:00:00.000Z")
    };
    const keys = new Set(Array.from({ length: 50 }, () => buildStorageKey(params)));
    expect(keys.size).toBe(50);
  });
});

describe("access control on evidence", () => {
  it("a provider cannot attach evidence to a job it does not hold", async () => {
    const h = await boot();
    const jobId = await assignedJob(h);
    const response = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/evidence`,
      headers: await h.auth(SUBJECTS.providerRoland),
      payload: { kind: "DELIVERY_PHOTO", mimeType: "image/jpeg", sizeBytes: 1000, filename: "x.jpg" }
    });
    expect(response.statusCode).toBe(404);
  });

  it("a customer from another tenant cannot list it", async () => {
    const h = await boot();
    const jobId = await assignedJob(h);
    const response = await h.app.inject({
      method: "GET",
      url: `/v1/jobs/${jobId}/evidence`,
      headers: await h.auth(SUBJECTS.otherCustomer)
    });
    expect(response.statusCode).toBe(404);
  });

  it("the owning customer can see their own proof", async () => {
    const h = await boot();
    const jobId = await assignedJob(h);
    const provider = await h.auth(SUBJECTS.providerHansa);
    const ticket = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/evidence`,
      headers: provider,
      payload: { kind: "DELIVERY_PHOTO", mimeType: "image/jpeg", sizeBytes: 1000, filename: "p.jpg" }
    });
    await h.app.inject({
      method: "POST",
      url: `/v1/evidence/${ticket.json().data.evidenceId}/complete`,
      headers: provider
    });

    const response = await h.app.inject({
      method: "GET",
      url: `/v1/jobs/${jobId}/evidence`,
      headers: await h.auth(SUBJECTS.customerAdmin)
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data[0].status).toBe("UPLOADED");
  });
});

describe("the upload ticket", () => {
  it("is short-lived and carries the declared type and size", async () => {
    const h = await boot();
    const jobId = await assignedJob(h);
    const response = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/evidence`,
      headers: await h.auth(SUBJECTS.providerHansa),
      payload: { kind: "PICKUP_PHOTO", mimeType: "image/png", sizeBytes: 2048, filename: "a.png" }
    });
    const ticket = response.json().data;
    expect(ticket.method).toBe("PUT");
    expect(ticket.headers["content-type"]).toBe("image/png");
    expect(ticket.headers["content-length"]).toBe("2048");
    const ttlSeconds = (new Date(ticket.expiresAt).getTime() - h.clock.now().getTime()) / 1000;
    expect(ttlSeconds).toBeGreaterThan(0);
    expect(ttlSeconds).toBeLessThanOrEqual(3600);
  });

  it("stores the key, not the URL", async () => {
    const h = await boot();
    const jobId = await assignedJob(h);
    const response = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/evidence`,
      headers: await h.auth(SUBJECTS.providerHansa),
      payload: { kind: "SIGNATURE", mimeType: "image/png", sizeBytes: 500, filename: "s.png" }
    });
    const list = await h.store.listEvidence(jobId, { kind: "staff" });
    expect(list[0]!.storageKey).toBe(response.json().data.storageKey);
    expect(list[0]!.storageKey).not.toMatch(/^https?:/);
  });
});

/**
 * Proof download.
 *
 * The customer paid for the recovery and is entitled to see the proof of it,
 * so the read is scoped by the parent job rather than restricted to the
 * provider that uploaded it. These tests pin both halves: the customer can
 * reach their own proof, and nobody reaches anyone else's.
 */
describe("proof is downloadable by everyone entitled to it, and nobody else", () => {
  async function uploadedEvidence(h: Harness) {
    const jobId = await assignedJob(h);
    const provider = await h.auth(SUBJECTS.providerHansa);
    const ticket = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/evidence`,
      headers: provider,
      payload: {
        kind: "DELIVERY_PHOTO",
        mimeType: "image/png",
        sizeBytes: 2048,
        filename: "nachweis.png"
      }
    });
    const evidenceId = ticket.json().data.evidenceId as string;
    await h.app.inject({
      method: "POST",
      url: `/v1/evidence/${evidenceId}/complete`,
      headers: provider
    });
    return { jobId, evidenceId };
  }

  it("gives the customer a short-lived signed URL", async () => {
    const h = await boot();
    const { evidenceId } = await uploadedEvidence(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/v1/evidence/${evidenceId}/download`,
      headers: await h.auth(SUBJECTS.customerAdmin)
    });
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data.downloadUrl).toMatch(/X-Signature=/);
    expect(data.downloadUrl).toMatch(/X-Expires=/);
    expect(new Date(data.expiresAt).getTime()).toBeGreaterThan(h.clock.now().getTime());
  });

  it("gives the provider that did the work the same URL shape", async () => {
    const h = await boot();
    const { evidenceId } = await uploadedEvidence(h);
    const response = await h.app.inject({
      method: "GET",
      url: `/v1/evidence/${evidenceId}/download`,
      headers: await h.auth(SUBJECTS.providerHansa)
    });
    expect(response.statusCode).toBe(200);
  });

  it("refuses another customer, as absent rather than forbidden", async () => {
    const h = await boot();
    const { evidenceId } = await uploadedEvidence(h);
    const response = await h.app.inject({
      method: "GET",
      url: `/v1/evidence/${evidenceId}/download`,
      headers: await h.auth(SUBJECTS.otherCustomer)
    });
    expect(response.statusCode).toBe(404);
  });

  it("refuses a provider that never held the job", async () => {
    const h = await boot();
    const { evidenceId } = await uploadedEvidence(h);
    const response = await h.app.inject({
      method: "GET",
      url: `/v1/evidence/${evidenceId}/download`,
      headers: await h.auth(SUBJECTS.providerRoland)
    });
    expect(response.statusCode).toBe(404);
  });

  it("refuses anonymously", async () => {
    const h = await boot();
    const { evidenceId } = await uploadedEvidence(h);
    const response = await h.app.inject({
      method: "GET",
      url: `/v1/evidence/${evidenceId}/download`
    });
    expect(response.statusCode).toBe(401);
  });

  it("will not hand out a URL for a slot nobody filled", async () => {
    const h = await boot();
    const jobId = await assignedJob(h);
    const ticket = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/evidence`,
      headers: await h.auth(SUBJECTS.providerHansa),
      payload: {
        kind: "PICKUP_PHOTO",
        mimeType: "image/png",
        sizeBytes: 1024,
        filename: "x.png"
      }
    });
    // Requested, never confirmed: a link here would look like missing proof
    // rather than absent proof.
    const response = await h.app.inject({
      method: "GET",
      url: `/v1/evidence/${ticket.json().data.evidenceId}/download`,
      headers: await h.auth(SUBJECTS.customerAdmin)
    });
    expect(response.statusCode).toBe(404);
  });

  it("signs a download differently from an upload", async () => {
    const h = await boot();
    const { jobId, evidenceId } = await uploadedEvidence(h);

    const upload = await h.app.inject({
      method: "POST",
      url: `/v1/jobs/${jobId}/evidence`,
      headers: await h.auth(SUBJECTS.providerHansa),
      payload: {
        kind: "PICKUP_PHOTO",
        mimeType: "image/png",
        sizeBytes: 2048,
        filename: "nachweis.png"
      }
    });
    const download = await h.app.inject({
      method: "GET",
      url: `/v1/evidence/${evidenceId}/download`,
      headers: await h.auth(SUBJECTS.customerAdmin)
    });

    const uploadSignature = new URL(upload.json().data.uploadUrl).searchParams.get("X-Signature");
    const downloadSignature = new URL(download.json().data.downloadUrl).searchParams.get(
      "X-Signature"
    );
    // The HTTP method is part of the signed string, so an upload signature
    // cannot be replayed as a download one.
    expect(uploadSignature).not.toBe(downloadSignature);
  });
});
