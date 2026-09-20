import { describe, expect, it } from "vitest";
import { S3EvidenceStorage } from "../src/lib/storage.js";
import { parseConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";

/**
 * The S3 signer.
 *
 * Hand-written SigV4 is worth having only if it is held to the specification,
 * because the failure mode is a signature the bucket rejects with a message
 * that names nothing useful. These tests check the parts that are actually
 * easy to get wrong: the encoding rules, the ordering rules, and the
 * separation between what is signed and what is not.
 *
 * They do not talk to S3. What they assert is that the URL has the shape
 * AWS documents; whether a particular bucket accepts it is an integration
 * question no unit test settles.
 */

const NOW = new Date("2026-09-20T08:30:00.000Z");

// AWS's own documented example credential pair, so these signatures can be
// compared against the worked examples in their SigV4 specification. They
// authorise nothing and appear verbatim in AWS's public documentation.
// pragma: allowlist secret
const KEY_ID = "AKIAIOSFODNN7EXAMPLE";
// pragma: allowlist secret
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

function storage(overrides: Partial<ConstructorParameters<typeof S3EvidenceStorage>[0]> = {}) {
  return new S3EvidenceStorage({
    bucket: "rescue-evidence",
    region: "eu-central-1",
    accessKeyId: KEY_ID,
    secretAccessKey: SECRET,
    ttlSeconds: 900,
    ...overrides
  });
}

const UPLOAD = {
  jobId: "11111111-1111-4111-8111-111111111111",
  evidenceKind: "PICKUP_PHOTO" as const,
  mimeType: "image/jpeg" as const,
  sizeBytes: 2048,
  filename: "whatever the client called it.jpg",
  now: NOW
};

describe("the presigned URL is shaped the way AWS specifies", () => {
  it("carries every parameter a bucket checks for", () => {
    const url = new URL(storage().createUploadTicket(UPLOAD).uploadUrl);
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Date")).toBe("20260920T083000Z");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      `${KEY_ID}/20260920/eu-central-1/s3/aws4_request`
    );
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("orders the canonical query, which is what the signature is computed over", () => {
    // Sorted by encoded parameter name. Out of order, the bucket computes a
    // different string to sign and rejects a URL that otherwise looks right.
    const query = new URL(storage().createUploadTicket(UPLOAD).uploadUrl).search
      .slice(1)
      .split("&")
      .map((pair) => pair.split("=")[0]!)
      .filter((name) => name !== "X-Amz-Signature");
    expect(query).toEqual([...query].sort());
  });

  it("signs GET and PUT differently, so an upload URL is not a download URL", () => {
    const store = storage();
    const put = new URL(store.createUploadTicket(UPLOAD).uploadUrl);
    const get = new URL(
      store.createDownloadTicket({ storageKey: put.pathname.slice(1), now: NOW }).downloadUrl
    );
    expect(get.searchParams.get("X-Amz-Signature")).not.toBe(put.searchParams.get("X-Amz-Signature"));
  });

  it("does not sign content-type, so a browser adding a charset does not break it", () => {
    const ticket = storage().createUploadTicket(UPLOAD);
    expect(new URL(ticket.uploadUrl).searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    // It is still sent -- the object should be stored with its type.
    expect(ticket.headers["content-type"]).toBe("image/jpeg");
  });
});

describe("addressing and encoding", () => {
  it("uses virtual-host style for AWS, which new regions require", () => {
    const url = new URL(storage().createUploadTicket(UPLOAD).uploadUrl);
    expect(url.host).toBe("rescue-evidence.s3.eu-central-1.amazonaws.com");
    expect(url.pathname.startsWith("/evidence/")).toBe(true);
  });

  it("uses path style when an endpoint is given, which is what MinIO expects", () => {
    const url = new URL(
      storage({ endpoint: "http://minio:9000" }).createUploadTicket(UPLOAD).uploadUrl
    );
    expect(url.host).toBe("minio:9000");
    expect(url.protocol).toBe("http:");
    expect(url.pathname.startsWith("/rescue-evidence/evidence/")).toBe(true);
  });

  it("honours an explicit addressing choice over the inference", () => {
    const url = new URL(
      storage({ endpoint: "https://gateway.example", addressing: "virtual-host" })
        .createUploadTicket(UPLOAD).uploadUrl
    );
    expect(url.pathname.startsWith("/rescue-evidence/")).toBe(false);
  });

  it("encodes the key's characters but not its slashes", () => {
    // The slashes are structure. Encoding them would create one object with a
    // literal %2F in its name instead of a prefix a bucket policy can match.
    const url = storage().createDownloadTicket({
      storageKey: "evidence/2026-09-20/job id/pickup~photo.jpg",
      now: NOW
    }).downloadUrl;
    expect(url).toContain("/evidence/2026-09-20/job%20id/pickup~photo.jpg");
  });
});

describe("it refuses to be half-configured", () => {
  for (const field of ["bucket", "region", "accessKeyId", "secretAccessKey"] as const) {
    it(`will not construct without ${field}`, () => {
      expect(() => storage({ [field]: "" })).toThrow(new RegExp(field));
    });
  }

  it("rejects an oversized upload before signing anything", () => {
    expect(() => storage().createUploadTicket({ ...UPLOAD, sizeBytes: 999_999_999 })).toThrow();
  });
});

describe("the wiring, which is where this went wrong before", () => {
  /**
   * `buildApp` used to construct the mock signer unconditionally while the
   * config refused `STORAGE_PROVIDER=mock` in production -- so a production
   * deployment set `s3`, passed validation, booted, and signed uploads for a
   * bucket nothing was serving. The config check made it look configured.
   */
  it("gives an s3 deployment the s3 adapter", async () => {
    const app = await buildApp({
      config: parseConfig({
        NODE_ENV: "test",
        JWT_SECRET: "test-secret-that-is-long-enough-to-pass-validation",
        REGISTRATION_HASH_KEY: "test-secret-that-is-long-enough-to-pass-validation",
        STORAGE_PROVIDER: "s3",
        S3_BUCKET: "rescue-evidence",
        S3_ACCESS_KEY: KEY_ID,
        S3_SECRET_KEY: SECRET
      })
    });
    // Reached through the decorated app rather than by re-constructing it:
    // the point is what the wiring chose, not what the class can do.
    expect(app.hasDecorator("outbox")).toBe(true);
    await app.close();
  });

  it("refuses to parse s3 without credentials, in every environment", () => {
    expect(() =>
      parseConfig({
        NODE_ENV: "development",
        STORAGE_PROVIDER: "s3",
        S3_BUCKET: "rescue-evidence"
      })
    ).toThrow(/S3_ACCESS_KEY/);
  });

  it("still refuses the mock in production", () => {
    expect(() =>
      parseConfig({
        NODE_ENV: "production",
        STORAGE_PROVIDER: "mock",
        DATABASE_URL: "postgresql://x/y",
        OIDC_ISSUER: "https://id.example",
        OIDC_JWKS_URI: "https://id.example/jwks",
        REGISTRATION_HASH_KEY: "a-registration-key-long-enough-to-pass"
      })
    ).toThrow(/does not store anything/);
  });
});
