import { createHmac, randomBytes } from "node:crypto";
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
