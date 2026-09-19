import { z } from "zod";
import { centsSchema, currencySchema, isoDateTime, uuid } from "./common.js";

/* ------------------------------------------------------------------ quotes */

export const quoteStatuses = ["DRAFT", "SENT", "APPROVED", "REJECTED", "EXPIRED"] as const;
export const quoteStatusSchema = z.enum(quoteStatuses);
export type QuoteStatus = z.infer<typeof quoteStatusSchema>;

/** German standard VAT rate in basis points (19.00%). */
export const VAT_RATE_BASIS_POINTS = 1900;

export const createQuoteSchema = z.object({
  netCents: centsSchema.refine((value) => value > 0, "A quote must be greater than zero"),
  /** Basis points, so 1900 is 19%. Integer arithmetic only. */
  vatRateBasisPoints: z.number().int().min(0).max(10_000).default(VAT_RATE_BASIS_POINTS),
  validForHours: z.number().int().min(1).max(720).default(72),
  breakdown: z
    .array(
      z.object({
        label: z.string().min(2).max(120),
        netCents: centsSchema
      })
    )
    .max(20)
    .optional(),
  notes: z.string().max(1000).optional()
});
export type CreateQuoteInput = z.infer<typeof createQuoteSchema>;

export const quoteSchema = z.object({
  id: uuid(),
  jobId: uuid(),
  organizationId: uuid(),
  status: quoteStatusSchema,
  netCents: centsSchema,
  vatCents: centsSchema,
  grossCents: centsSchema,
  vatRateBasisPoints: z.number().int(),
  currency: currencySchema,
  validUntil: isoDateTime(),
  approvedAt: isoDateTime().nullable(),
  approvedByUserId: uuid().nullable(),
  createdAt: isoDateTime()
});
export type Quote = z.infer<typeof quoteSchema>;

export const decideQuoteSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  reason: z.string().max(500).optional()
});
export type DecideQuoteInput = z.infer<typeof decideQuoteSchema>;

/* ------------------------------------------------------------- assignments */

export const offerStatuses = ["PENDING", "ACCEPTED", "DECLINED", "EXPIRED", "WITHDRAWN"] as const;
export const offerStatusSchema = z.enum(offerStatuses);
export type OfferStatus = z.infer<typeof offerStatusSchema>;

export const createOffersSchema = z.object({
  /** Payout to the provider, net of RESCUE's margin. Integer cents. */
  payoutNetCents: centsSchema.refine((value) => value > 0, "A payout must be greater than zero"),
  expiresInMinutes: z.number().int().min(1).max(1440).default(20),
  /** Cap on how many providers are offered the job at once. */
  maxProviders: z.number().int().min(1).max(20).default(5)
});
export type CreateOffersInput = z.infer<typeof createOffersSchema>;

export const assignmentOfferSchema = z.object({
  id: uuid(),
  jobId: uuid(),
  providerId: uuid(),
  status: offerStatusSchema,
  payoutNetCents: centsSchema,
  currency: currencySchema,
  expiresAt: isoDateTime(),
  respondedAt: isoDateTime().nullable(),
  createdAt: isoDateTime()
});
export type AssignmentOffer = z.infer<typeof assignmentOfferSchema>;

export const respondToOfferSchema = z.object({
  decision: z.enum(["ACCEPT", "DECLINE"]),
  reason: z.string().max(500).optional()
});
export type RespondToOfferInput = z.infer<typeof respondToOfferSchema>;

export const assignmentSchema = z.object({
  id: uuid(),
  jobId: uuid(),
  providerId: uuid(),
  status: z.enum(["ACTIVE", "FELL_THROUGH", "COMPLETED"]),
  payoutNetCents: centsSchema,
  currency: currencySchema,
  acceptedAt: isoDateTime(),
  completedAt: isoDateTime().nullable()
});
export type Assignment = z.infer<typeof assignmentSchema>;

export const fallbackSchema = z.object({
  reason: z.string().min(3).max(500)
});
export type FallbackInput = z.infer<typeof fallbackSchema>;

/* ---------------------------------------------------------------- evidence */

export const evidenceKinds = ["PICKUP_PHOTO", "DELIVERY_PHOTO", "SIGNATURE", "DAMAGE_REPORT"] as const;
export const evidenceKindSchema = z.enum(evidenceKinds);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

/**
 * Only these content types may be uploaded as evidence. An allowlist, not a
 * denylist: anything unrecognised is refused. SVG is deliberately excluded
 * because it executes script when served inline.
 */
export const ALLOWED_EVIDENCE_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf"
] as const;
export const evidenceMimeTypeSchema = z.enum(ALLOWED_EVIDENCE_MIME_TYPES);
export type EvidenceMimeType = z.infer<typeof evidenceMimeTypeSchema>;

/** 20 MB. Enforced when the upload is requested and again on completion. */
export const MAX_EVIDENCE_BYTES = 20 * 1024 * 1024;

export const requestEvidenceUploadSchema = z.object({
  kind: evidenceKindSchema,
  mimeType: evidenceMimeTypeSchema,
  sizeBytes: z.number().int().min(1).max(MAX_EVIDENCE_BYTES),
  /** Client-supplied filename, used only for the extension. Never a path. */
  filename: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._-]+$/, "Filename may contain only letters, digits, dot, underscore and hyphen")
    .refine((value) => !value.includes(".."), "Filename may not contain '..'")
});
export type RequestEvidenceUploadInput = z.infer<typeof requestEvidenceUploadSchema>;

export const evidenceUploadTicketSchema = z.object({
  evidenceId: uuid(),
  /** Short-lived signed URL. The database stores only the object key. */
  uploadUrl: z.string().url(),
  storageKey: z.string(),
  method: z.literal("PUT"),
  headers: z.record(z.string(), z.string()),
  maxBytes: z.number().int(),
  expiresAt: isoDateTime()
});
export type EvidenceUploadTicket = z.infer<typeof evidenceUploadTicketSchema>;

export const evidenceSchema = z.object({
  id: uuid(),
  jobId: uuid(),
  kind: evidenceKindSchema,
  status: z.enum(["REQUESTED", "UPLOADED", "REJECTED"]),
  mimeType: evidenceMimeTypeSchema,
  sizeBytes: z.number().int(),
  storageKey: z.string(),
  uploadedByUserId: uuid().nullable(),
  createdAt: isoDateTime()
});
export type Evidence = z.infer<typeof evidenceSchema>;
