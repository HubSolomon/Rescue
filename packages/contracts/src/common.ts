import { z } from "zod";

export const uuid = () => z.string().uuid();
export const isoDateTime = () => z.string().datetime();

/**
 * Money is always an integer count of euro cents. There is no floating point
 * anywhere in the monetary path: cents are produced, stored, summed and
 * rendered as integers, and only formatted for display at the very edge.
 */
export const centsSchema = z
  .number()
  .int("Monetary amounts must be whole euro cents")
  .min(0)
  .max(100_000_000);

export const currencySchema = z.literal("EUR");

export const moneySchema = z.object({
  netCents: centsSchema,
  vatCents: centsSchema,
  grossCents: centsSchema,
  currency: currencySchema
});
export type Money = z.infer<typeof moneySchema>;

export const addressSchema = z.object({
  line1: z.string().min(3).max(160),
  line2: z.string().max(160).optional(),
  postalCode: z.string().regex(/^\d{5}$/, "Use a five-digit German postal code"),
  city: z.string().min(2).max(100),
  countryCode: z.literal("DE").default("DE")
});
export type Address = z.infer<typeof addressSchema>;

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional()
});
export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Success envelope: `{ data, meta? }`, per docs/ARCHITECTURE.md. */
export function successSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    data,
    meta: z.object({ nextCursor: z.string().nullable().optional() }).partial().optional()
  });
}

/** Error envelope: `{ error: { code, message, details? } }`. */
export const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional()
  })
});
export type ErrorResponse = z.infer<typeof errorSchema>;

/**
 * Error codes are part of the API contract. Clients branch on these, so they
 * are enumerated here rather than invented at each throw site.
 */
export const errorCodes = [
  "VALIDATION_ERROR",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "ORGANIZATION_REQUIRED",
  "PROVIDER_CONTEXT_REQUIRED",
  "NOT_FOUND",
  "CONFLICT",
  "IDEMPOTENCY_KEY_REQUIRED",
  "IDEMPOTENCY_KEY_REUSED",
  "INVALID_STATE_TRANSITION",
  "OFFER_EXPIRED",
  "OFFER_ALREADY_TAKEN",
  "NO_ELIGIBLE_PROVIDER",
  "UNSUPPORTED_MEDIA_TYPE",
  "PAYLOAD_TOO_LARGE",
  "RATE_LIMITED",
  "INTERNAL_ERROR"
] as const;
export type ErrorCode = (typeof errorCodes)[number];
