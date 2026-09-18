import { z } from "zod";

export const jobTypes = ["FAILED_DELIVERY", "BULKY_RETURN", "COMPANY_SURPLUS"] as const;
export const jobStatuses = ["DRAFT", "TRIAGED", "QUOTED", "ASSIGNED", "IN_PROGRESS", "COMPLETED", "CANCELLED"] as const;

export const addressSchema = z.object({
  line1: z.string().min(3).max(160),
  line2: z.string().max(160).optional(),
  postalCode: z.string().regex(/^\d{5}$/, "Use a five-digit German postal code"),
  city: z.string().min(2).max(100),
  countryCode: z.literal("DE").default("DE")
});

export const itemSchema = z.object({
  name: z.string().min(2).max(120),
  quantity: z.number().int().min(1).max(100),
  estimatedWeightKg: z.number().positive().max(5000).optional(),
  dimensionsCm: z.object({ length: z.number().positive(), width: z.number().positive(), height: z.number().positive() }).optional(),
  reusable: z.boolean().optional(),
  notes: z.string().max(1000).optional()
});

export const createJobSchema = z.object({
  organizationId: z.string().uuid(),
  type: z.enum(jobTypes),
  urgency: z.enum(["SCHEDULED", "SAME_DAY", "URGENT"]),
  pickup: addressSchema,
  destination: addressSchema.optional(),
  items: z.array(itemSchema).min(1).max(50),
  stairs: z.number().int().min(0).max(20).default(0),
  liftAvailable: z.boolean().default(false),
  requestedAt: z.string().datetime().optional(),
  customerReference: z.string().max(100).optional(),
  notes: z.string().max(2000).optional()
});

export const jobSchema = createJobSchema.extend({
  id: z.string().uuid(),
  status: z.enum(jobStatuses),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const triageSuggestionSchema = z.object({
  vehicleClass: z.enum(["CARGO_BIKE", "SMALL_VAN", "LARGE_VAN", "BOX_VAN", "TRUCK", "MANUAL_REVIEW"]),
  workers: z.number().int().min(1).max(6),
  estimatedMinutes: z.number().int().positive(),
  circularRoute: z.enum(["DELIVER", "RETURN", "STORE", "REPAIR", "REUSE", "DONATE", "RECYCLE", "DISPOSAL", "MANUAL_REVIEW"]),
  risks: z.array(z.string().max(200)).max(20),
  confidence: z.number().min(0).max(1),
  requiresHumanApproval: z.literal(true)
});

export type CreateJobInput = z.infer<typeof createJobSchema>;
export type Job = z.infer<typeof jobSchema>;
export type TriageSuggestion = z.infer<typeof triageSuggestionSchema>;
