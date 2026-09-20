import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  ALLOWED_EVIDENCE_MIME_TYPES,
  MAX_EVIDENCE_BYTES,
  type EvidenceKind,
  type EvidenceMimeType
} from "@rescue/contracts";
import { AppError } from "./errors.js";

/**
 * Evidence upload tickets.
 *
 * The API never receives file bytes. It issues a short-lived signed URL the
 * client PUTs to directly, and stores only the object key -- never a URL,
 * never the file, never a path the client chose.
 */

export interface UploadTicket {
  uploadUrl: string;
  storageKey: string;
  headers: Record<string, string>;
  maxBytes: number;
  expiresAt: Date;
}

export interface DownloadTicket {
  downloadUrl: string;
  expiresAt: Date;
}

export interface EvidenceStorage {
  readonly kind: "mock" | "s3";
  createUploadTicket(params: {
    jobId: string;
    evidenceKind: EvidenceKind;
    mimeType: EvidenceMimeType;
    sizeBytes: number;
    filename: string;
    now: Date;
  }): UploadTicket;
  /**
   * A short-lived signed GET for an object the caller has already been
   * authorised to read. The signer does not decide who may read; the route
   * does, before it asks for a ticket.
   */
  createDownloadTicket(params: { storageKey: string; now: Date }): DownloadTicket;
  /**
   * Removes the object.
   *
   * The retention job needs this: deleting the row and leaving the photograph
   * in the bucket produces a system that passes an audit of its database and
   * fails an audit of its storage. Deleting an object that is already gone is
   * not an error -- retention runs again tomorrow, and a sweep that fails on
   * its own previous success never finishes.
   */
  delete(storageKey: string): Promise<void>;
}

const EXTENSION_BY_MIME: Record<EvidenceMimeType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf"
};

/**
 * Builds the object key. The client's filename never reaches it: the key is
 * derived from server-side values plus random bytes, and the extension comes
 * from the validated MIME type rather than from the name. That closes path
 * traversal and content-type confusion in one step.
 */
export function buildStorageKey(params: {
  jobId: string;
  evidenceKind: EvidenceKind;
  mimeType: EvidenceMimeType;
  now: Date;
}): string {
  const date = params.now.toISOString().slice(0, 10);
  const nonce = randomBytes(16).toString("hex");
  return `evidence/${date}/${params.jobId}/${params.evidenceKind.toLowerCase()}-${nonce}.${EXTENSION_BY_MIME[params.mimeType]}`;
}

export function assertUploadAllowed(mimeType: string, sizeBytes: number): asserts mimeType is EvidenceMimeType {
  if (!(ALLOWED_EVIDENCE_MIME_TYPES as readonly string[]).includes(mimeType)) {
    throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", `${mimeType} is not an accepted evidence type`);
  }
  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > MAX_EVIDENCE_BYTES) {
    throw new AppError(
      413,
      "PAYLOAD_TOO_LARGE",
      `Evidence must be between 1 byte and ${MAX_EVIDENCE_BYTES} bytes`
    );
  }
}

/**
 * Development signer. Produces a URL shaped like a real presigned PUT and
 * signed with a local key, so client code exercises the same flow. It stores
 * nothing; `parseConfig` refuses STORAGE_PROVIDER=mock in production.
 */
export class MockEvidenceStorage implements EvidenceStorage {
  readonly kind = "mock" as const;

  constructor(
    private readonly endpoint: string,
    private readonly bucket: string,
    private readonly signingKey: string,
    private readonly ttlSeconds: number
  ) {}

  createUploadTicket(params: {
    jobId: string;
    evidenceKind: EvidenceKind;
    mimeType: EvidenceMimeType;
    sizeBytes: number;
    filename: string;
    now: Date;
  }): UploadTicket {
    assertUploadAllowed(params.mimeType, params.sizeBytes);
    const storageKey = buildStorageKey(params);
    const expiresAt = new Date(params.now.getTime() + this.ttlSeconds * 1000);
    const expiresUnix = Math.floor(expiresAt.getTime() / 1000);
    const signature = createHmac("sha256", this.signingKey)
      .update(`PUT\n${this.bucket}\n${storageKey}\n${expiresUnix}\n${params.mimeType}\n${params.sizeBytes}`)
      .digest("hex");

    const url = new URL(`${this.endpoint.replace(/\/$/, "")}/${this.bucket}/${storageKey}`);
    url.searchParams.set("X-Signature", signature);
    url.searchParams.set("X-Expires", String(expiresUnix));

    return {
      uploadUrl: url.toString(),
      storageKey,
      headers: {
        "content-type": params.mimeType,
        "content-length": String(params.sizeBytes)
      },
      maxBytes: params.sizeBytes,
      expiresAt
    };
  }

  createDownloadTicket(params: { storageKey: string; now: Date }): DownloadTicket {
    const expiresAt = new Date(params.now.getTime() + this.ttlSeconds * 1000);
    const expiresUnix = Math.floor(expiresAt.getTime() / 1000);
    // The method is part of the signed string, so an upload signature cannot
    // be replayed as a download one or the reverse.
    const signature = createHmac("sha256", this.signingKey)
      .update(`GET\n${this.bucket}\n${params.storageKey}\n${expiresUnix}`)
      .digest("hex");

    const url = new URL(`${this.endpoint.replace(/\/$/, "")}/${this.bucket}/${params.storageKey}`);
    url.searchParams.set("X-Signature", signature);
    url.searchParams.set("X-Expires", String(expiresUnix));
    return { downloadUrl: url.toString(), expiresAt };
  }

  /**
   * Records the key and returns.
   *
   * The mock never stored an object, so there is nothing to remove -- but a
   * silent no-op would let the retention job report a clean sweep in a
   * development run and leave every photograph in place in a real one. The
   * keys are kept so a test can assert the job asked, and `deleted` is the
   * only way to tell the difference between "removed" and "never called".
   */
  readonly deleted: string[] = [];
  async delete(storageKey: string): Promise<void> {
    this.deleted.push(storageKey);
  }
}

/* -------------------------------------------------------------------- S3 */

/**
 * The real signer: AWS Signature Version 4, against S3 or anything that
 * speaks it (MinIO, R2, Backblaze, Scaleway).
 *
 * Written against the specification rather than pulled from the AWS SDK. The
 * SDK is forty megabytes and several hundred transitive packages to produce
 * three signatures, and this service needs exactly three: a presigned PUT, a
 * presigned GET, and an authenticated DELETE. SigV4 is a stable, published
 * algorithm; the cost of writing it is one afternoon and the cost of the SDK
 * is a permanent supply-chain surface. That trade is the same one the metrics
 * registry and the secret scanner in this repository already make.
 *
 * Presigning is query-string SigV4, so the browser PUTs with no Authorization
 * header and nothing but the URL. Deletion is header SigV4, because the
 * retention job performs it itself rather than handing it to anyone.
 */

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Omit for AWS. Set for MinIO, R2 and the rest: `https://host[:port]`. */
  endpoint?: string;
  /**
   * `path` puts the bucket in the path (`host/bucket/key`), which is what
   * MinIO and most self-hosted gateways expect; `virtual-host` puts it in the
   * name (`bucket.host/key`), which is AWS's own default and the only style
   * new AWS regions support.
   */
  addressing?: "path" | "virtual-host";
  ttlSeconds: number;
}

const UNRESERVED = /[^A-Za-z0-9\-._~]/g;

/** RFC 3986. `encodeURIComponent` leaves !*'() alone and S3 does not. */
function uriEncode(value: string): string {
  return value.replace(UNRESERVED, (char) =>
    "%" + Buffer.from(char, "utf8").toString("hex").toUpperCase().match(/../g)!.join("%")
  );
}

/** The key is encoded segment by segment: the slashes are structure, not data. */
function encodeKey(key: string): string {
  return key.split("/").map(uriEncode).join("/");
}

function sha256Hex(payload: string): string {
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function stamps(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

function signingKey(secret: string, dateStamp: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac("AWS4" + secret, dateStamp), region), "s3"), "aws4_request");
}

export class S3EvidenceStorage implements EvidenceStorage {
  readonly kind = "s3" as const;
  private readonly addressing: "path" | "virtual-host";

  constructor(private readonly config: S3Config) {
    for (const field of ["bucket", "region", "accessKeyId", "secretAccessKey"] as const) {
      if (!config[field]) throw new Error(`S3EvidenceStorage requires ${field}`);
    }
    // AWS itself is virtual-host by default; anything self-hosted is not.
    this.addressing = config.addressing ?? (config.endpoint ? "path" : "virtual-host");
  }

  private host(): string {
    if (this.config.endpoint) return new URL(this.config.endpoint).host;
    return this.addressing === "virtual-host"
      ? `${this.config.bucket}.s3.${this.config.region}.amazonaws.com`
      : `s3.${this.config.region}.amazonaws.com`;
  }

  private scheme(): string {
    return this.config.endpoint ? new URL(this.config.endpoint).protocol.replace(":", "") : "https";
  }

  private canonicalPath(key: string): string {
    const encoded = "/" + encodeKey(key);
    return this.addressing === "path" ? `/${uriEncode(this.config.bucket)}${encoded}` : encoded;
  }

  /**
   * A presigned URL for one method on one key.
   *
   * `signedHeaders` is host only. Signing content-type or content-length would
   * pin them, and a browser that adds a charset or a proxy that re-chunks then
   * produces a signature mismatch the user sees as "upload failed" with no
   * explanation. The size limit is enforced by the bucket policy instead,
   * which is where a limit belongs: a limit a client could avoid by not
   * sending a header is not a limit.
   */
  private presign(method: "GET" | "PUT", key: string, now: Date): { url: string; expiresAt: Date } {
    const { amzDate, dateStamp } = stamps(now);
    const host = this.host();
    const credentialScope = `${dateStamp}/${this.config.region}/s3/aws4_request`;

    const query = new Map<string, string>([
      ["X-Amz-Algorithm", "AWS4-HMAC-SHA256"],
      ["X-Amz-Credential", `${this.config.accessKeyId}/${credentialScope}`],
      ["X-Amz-Date", amzDate],
      ["X-Amz-Expires", String(this.config.ttlSeconds)],
      ["X-Amz-SignedHeaders", "host"]
    ]);

    // Canonical query: sorted by encoded key, every value encoded.
    const canonicalQuery = [...query.entries()]
      .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");

    const canonicalRequest = [
      method,
      this.canonicalPath(key),
      canonicalQuery,
      `host:${host}\n`,
      "host",
      // UNSIGNED-PAYLOAD: the body is not known at signing time, which is the
      // entire point of handing the URL to a browser.
      "UNSIGNED-PAYLOAD"
    ].join("\n");

    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest)
    ].join("\n");

    const signature = hmac(
      signingKey(this.config.secretAccessKey, dateStamp, this.config.region),
      stringToSign
    ).toString("hex");

    return {
      url: `${this.scheme()}://${host}${this.canonicalPath(key)}?${canonicalQuery}&X-Amz-Signature=${signature}`,
      expiresAt: new Date(now.getTime() + this.config.ttlSeconds * 1000)
    };
  }

  createUploadTicket(params: {
    jobId: string;
    evidenceKind: EvidenceKind;
    mimeType: EvidenceMimeType;
    sizeBytes: number;
    filename: string;
    now: Date;
  }): UploadTicket {
    assertUploadAllowed(params.mimeType, params.sizeBytes);
    const storageKey = buildStorageKey(params);
    const { url, expiresAt } = this.presign("PUT", storageKey, params.now);
    return {
      uploadUrl: url,
      storageKey,
      // Sent by the client but deliberately not signed -- see `presign`.
      headers: { "content-type": params.mimeType },
      maxBytes: params.sizeBytes,
      expiresAt
    };
  }

  createDownloadTicket(params: { storageKey: string; now: Date }): DownloadTicket {
    const { url, expiresAt } = this.presign("GET", params.storageKey, params.now);
    return { downloadUrl: url, expiresAt };
  }

  /**
   * Header SigV4, and performed here rather than presigned: retention deletes
   * the object itself, so there is nobody to hand a URL to.
   *
   * A 404 is success. The retention job runs again tomorrow over a window that
   * overlaps today's, and a sweep that fails on its own previous success never
   * finishes.
   */
  async delete(storageKey: string): Promise<void> {
    const now = new Date();
    const { amzDate, dateStamp } = stamps(now);
    const host = this.host();
    const path = this.canonicalPath(storageKey);
    const payloadHash = sha256Hex("");
    const credentialScope = `${dateStamp}/${this.config.region}/s3/aws4_request`;

    const canonicalRequest = [
      "DELETE",
      path,
      "",
      `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,
      "host;x-amz-content-sha256;x-amz-date",
      payloadHash
    ].join("\n");

    const signature = hmac(
      signingKey(this.config.secretAccessKey, dateStamp, this.config.region),
      ["AWS4-HMAC-SHA256", amzDate, credentialScope, sha256Hex(canonicalRequest)].join("\n")
    ).toString("hex");

    const response = await fetch(`${this.scheme()}://${host}${path}`, {
      method: "DELETE",
      headers: {
        host,
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
        authorization:
          `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${credentialScope}, ` +
          `SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`
      }
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(`S3 refused to delete ${storageKey}: ${response.status} ${response.statusText}`);
    }
  }
}
