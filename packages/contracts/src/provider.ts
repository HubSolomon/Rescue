import { z } from "zod";
import { isoDateTime, uuid } from "./common.js";
import { jobTypeSchema, vehicleClassSchema } from "./job.js";

export const providerStatuses = ["PENDING", "ACTIVE", "SUSPENDED", "REJECTED"] as const;
export const providerStatusSchema = z.enum(providerStatuses);
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

export const documentStatuses = ["PENDING", "VERIFIED", "EXPIRED", "REJECTED"] as const;
export const documentStatusSchema = z.enum(documentStatuses);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

export const documentTypes = [
  "LIABILITY_INSURANCE",
  "CARGO_INSURANCE",
  "TRADE_LICENCE",
  "WASTE_CARRIER_PERMIT",
  "VEHICLE_REGISTRATION"
] as const;
export const documentTypeSchema = z.enum(documentTypes);
export type DocumentType = z.infer<typeof documentTypeSchema>;

/**
 * Documents every active provider must hold. Eligibility requires each of
 * these to be VERIFIED and unexpired; see `evaluateProviderEligibility`.
 */
export const REQUIRED_DOCUMENT_TYPES = [
  "LIABILITY_INSURANCE",
  "TRADE_LICENCE"
] as const satisfies readonly DocumentType[];

export const createProviderSchema = z.object({
  legalName: z.string().min(2).max(200),
  basePostalCode: z.string().regex(/^\d{5}$/, "Use a five-digit German postal code"),
  serviceRadiusKm: z.number().int().min(1).max(200).default(30),
  serviceTypes: z.array(jobTypeSchema).min(1).max(3),
  contactEmail: z.string().email(),
  vatId: z.string().max(40).optional()
});
export type CreateProviderInput = z.infer<typeof createProviderSchema>;

export const providerSchema = createProviderSchema.extend({
  id: uuid(),
  status: providerStatusSchema,
  createdAt: isoDateTime(),
  updatedAt: isoDateTime()
});
export type Provider = z.infer<typeof providerSchema>;

export const reviewProviderSchema = z.object({
  status: z.enum(["ACTIVE", "SUSPENDED", "REJECTED"]),
  reason: z.string().min(3).max(500)
});
export type ReviewProviderInput = z.infer<typeof reviewProviderSchema>;

export const createVehicleSchema = z.object({
  /**
   * The plate is never stored. The client sends it once so the server can
   * derive a salted hash for de-duplication; the plaintext is discarded.
   */
  registration: z.string().min(2).max(20),
  vehicleClass: vehicleClassSchema,
  payloadKg: z.number().int().min(1).max(40_000),
  volumeM3: z.number().positive().max(200),
  active: z.boolean().default(true)
});
export type CreateVehicleInput = z.infer<typeof createVehicleSchema>;

export const vehicleSchema = z.object({
  id: uuid(),
  providerId: uuid(),
  vehicleClass: vehicleClassSchema,
  payloadKg: z.number().int(),
  volumeM3: z.number(),
  active: z.boolean(),
  createdAt: isoDateTime()
});
export type Vehicle = z.infer<typeof vehicleSchema>;

export const createProviderDocumentSchema = z.object({
  type: documentTypeSchema,
  storageKey: z.string().min(3).max(300),
  expiresAt: isoDateTime().optional()
});
export type CreateProviderDocumentInput = z.infer<typeof createProviderDocumentSchema>;

export const providerDocumentSchema = z.object({
  id: uuid(),
  providerId: uuid(),
  type: documentTypeSchema,
  status: documentStatusSchema,
  storageKey: z.string(),
  expiresAt: isoDateTime().nullable(),
  reviewedAt: isoDateTime().nullable(),
  createdAt: isoDateTime()
});
export type ProviderDocument = z.infer<typeof providerDocumentSchema>;

export const reviewDocumentSchema = z.object({
  status: z.enum(["VERIFIED", "REJECTED"]),
  reason: z.string().min(3).max(500)
});
export type ReviewDocumentInput = z.infer<typeof reviewDocumentSchema>;

/**
 * Why a provider was excluded. Returned to dispatchers so a human can see the
 * reasoning rather than an unexplained empty list.
 */
export const ineligibilityReasons = [
  "PROVIDER_NOT_ACTIVE",
  "SERVICE_TYPE_NOT_PERMITTED",
  "OUTSIDE_SERVICE_RADIUS",
  "MISSING_REQUIRED_DOCUMENT",
  "DOCUMENT_EXPIRED",
  "DOCUMENT_NOT_VERIFIED",
  "NO_SUITABLE_VEHICLE"
] as const;
export const ineligibilityReasonSchema = z.enum(ineligibilityReasons);
export type IneligibilityReason = z.infer<typeof ineligibilityReasonSchema>;

export const eligibilityResultSchema = z.object({
  providerId: uuid(),
  eligible: z.boolean(),
  reasons: z.array(ineligibilityReasonSchema),
  /** Lower ranks first. Only meaningful when `eligible` is true. */
  rank: z.number().int().nullable(),
  distanceKm: z.number().nullable()
});
export type EligibilityResult = z.infer<typeof eligibilityResultSchema>;
