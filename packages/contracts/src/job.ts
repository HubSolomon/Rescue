import { z } from "zod";
import { addressSchema, isoDateTime, uuid } from "./common.js";

export const jobTypes = ["FAILED_DELIVERY", "BULKY_RETURN", "COMPANY_SURPLUS"] as const;
export const jobTypeSchema = z.enum(jobTypes);
export type JobType = z.infer<typeof jobTypeSchema>;

export const jobStatuses = [
  "DRAFT",
  "TRIAGED",
  "QUOTED",
  "ASSIGNED",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED"
] as const;
export const jobStatusSchema = z.enum(jobStatuses);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const urgencies = ["SCHEDULED", "SAME_DAY", "URGENT"] as const;
export const urgencySchema = z.enum(urgencies);
export type Urgency = z.infer<typeof urgencySchema>;

export const vehicleClasses = ["CARGO_BIKE", "SMALL_VAN", "LARGE_VAN", "BOX_VAN", "TRUCK"] as const;
export const vehicleClassSchema = z.enum(vehicleClasses);
export type VehicleClass = z.infer<typeof vehicleClassSchema>;

/** Triage may also answer MANUAL_REVIEW, which is not a dispatchable vehicle. */
export const triageVehicleClassSchema = z.enum([...vehicleClasses, "MANUAL_REVIEW"]);
export type TriageVehicleClass = z.infer<typeof triageVehicleClassSchema>;

export const circularRoutes = [
  "DELIVER",
  "RETURN",
  "STORE",
  "REPAIR",
  "REUSE",
  "DONATE",
  "RECYCLE",
  "DISPOSAL",
  "MANUAL_REVIEW"
] as const;
export const circularRouteSchema = z.enum(circularRoutes);
export type CircularRoute = z.infer<typeof circularRouteSchema>;

export const itemSchema = z.object({
  name: z.string().min(2).max(120),
  quantity: z.number().int().min(1).max(100),
  estimatedWeightKg: z.number().positive().max(5000).optional(),
  dimensionsCm: z
    .object({
      length: z.number().positive().max(1000),
      width: z.number().positive().max(1000),
      height: z.number().positive().max(1000)
    })
    .optional(),
  reusable: z.boolean().optional(),
  notes: z.string().max(1000).optional()
});
export type Item = z.infer<typeof itemSchema>;

/**
 * Client-facing job input.
 *
 * `organizationId` is deliberately absent. The owning tenant is taken from the
 * authenticated principal's membership, never from the request body. See
 * finding C2 in docs/audits/FOUNDATION_AUDIT.md: the previous version of this
 * schema required the browser to supply it, which let any caller write into
 * another organisation.
 */
export const createJobSchema = z.object({
  type: jobTypeSchema,
  urgency: urgencySchema,
  pickup: addressSchema,
  destination: addressSchema.optional(),
  items: z.array(itemSchema).min(1).max(50),
  stairs: z.number().int().min(0).max(20).default(0),
  liftAvailable: z.boolean().default(false),
  requestedAt: isoDateTime().optional(),
  customerReference: z.string().max(100).optional(),
  notes: z.string().max(2000).optional()
});
export type CreateJobInput = z.infer<typeof createJobSchema>;

export const jobSchema = createJobSchema.extend({
  id: uuid(),
  organizationId: uuid(),
  status: jobStatusSchema,
  createdAt: isoDateTime(),
  updatedAt: isoDateTime()
});
export type Job = z.infer<typeof jobSchema>;

export const triageSuggestionSchema = z.object({
  vehicleClass: triageVehicleClassSchema,
  workers: z.number().int().min(1).max(6),
  estimatedMinutes: z.number().int().positive(),
  circularRoute: circularRouteSchema,
  risks: z.array(z.string().max(200)).max(20),
  confidence: z.number().min(0).max(1),
  /**
   * Always true. A suggestion is advisory data; only a dispatcher moves a job
   * out of DRAFT. Encoded as a literal so no code path can produce a
   * suggestion that claims to be self-approving.
   */
  requiresHumanApproval: z.literal(true)
});
export type TriageSuggestion = z.infer<typeof triageSuggestionSchema>;

export const approveTriageSchema = z.object({
  vehicleClass: vehicleClassSchema,
  workers: z.number().int().min(1).max(6),
  circularRoute: circularRouteSchema,
  dispatcherNotes: z.string().max(2000).optional()
});
export type ApproveTriageInput = z.infer<typeof approveTriageSchema>;

export const cancelJobSchema = z.object({
  reason: z.string().min(3).max(500)
});
export type CancelJobInput = z.infer<typeof cancelJobSchema>;

export const jobEventSchema = z.object({
  id: uuid(),
  jobId: uuid(),
  actorId: uuid().nullable(),
  type: z.string(),
  payload: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime()
});
export type JobEvent = z.infer<typeof jobEventSchema>;

/**
 * The only legal job status transitions, mirroring the state diagram in
 * docs/ARCHITECTURE.md. Anything not listed here is rejected with
 * INVALID_STATE_TRANSITION rather than silently applied.
 */
export const JOB_TRANSITIONS: Readonly<Record<JobStatus, readonly JobStatus[]>> = Object.freeze({
  DRAFT: ["TRIAGED", "CANCELLED"],
  TRIAGED: ["QUOTED", "CANCELLED"],
  QUOTED: ["ASSIGNED", "CANCELLED"],
  /**
   * A provider falling through returns the job to QUOTED, not TRIAGED.
   *
   * This deviates from the original diagram in docs/ARCHITECTURE.md; see
   * docs/adr/0001-fallback-returns-to-quoted.md. In short: the customer has
   * already approved a price, and returning to TRIAGED would require quoting
   * them again for work they already agreed to. QUOTED is also the only state
   * from which ASSIGNED is reachable, which is what guarantees no job is ever
   * dispatched without an approved price.
   */
  ASSIGNED: ["IN_PROGRESS", "QUOTED", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "QUOTED"],
  COMPLETED: [],
  CANCELLED: []
});

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}
