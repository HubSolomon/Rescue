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
}
