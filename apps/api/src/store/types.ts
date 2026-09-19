import type {
  CircularRoute,
  CreateJobInput,
  CreateProviderDocumentInput,
  CreateProviderInput,
  CreateVehicleInput,
  DocumentStatus,
  EvidenceKind,
  Job,
  JobStatus,
  OfferStatus,
  ProviderStatus,
  QuoteStatus,
  UserRole,
  VehicleClass
} from "@rescue/contracts";

/**
 * The persistence port.
 *
 * Two rules shape this interface, both from the Critical findings:
 *
 * 1. Every read that can touch a customer record takes a `Scope`. There is no
 *    overload without one and no optional parameter, so "forgot to filter by
 *    tenant" is a type error rather than a data breach (C3, C4).
 * 2. State changes that must be atomic -- a status change with its audit
 *    record, accepting an offer -- are single methods here rather than
 *    sequences the caller composes. An implementation can then use one
 *    transaction, and no call site can write half of one (H5).
 */

/**
 * Who a query runs as. `staff` deliberately reads across tenants and is only
 * ever constructed after a DISPATCHER, COMPLIANCE or ADMIN role check.
 */
export type Scope =
  | { kind: "organization"; organizationId: string }
  /** A provider sees the jobs it holds or has held an assignment on. */
  | { kind: "provider"; providerId: string }
  | { kind: "staff" };

export const orgScope = (organizationId: string): Scope => ({ kind: "organization", organizationId });
export const providerScope = (providerId: string): Scope => ({ kind: "provider", providerId });
export const staffScope = (): Scope => ({ kind: "staff" });

export interface Actor {
  userId: string;
  role: UserRole;
  correlationId?: string;
}

export interface StoredMembership {
  id: string;
  role: UserRole;
  organizationId: string | null;
  providerId: string | null;
}

export interface StoredUser {
  id: string;
  subject: string;
  email: string;
  name: string;
  memberships: StoredMembership[];
}

export interface StoredProvider {
  id: string;
  legalName: string;
  status: ProviderStatus;
  basePostalCode: string;
  serviceRadiusKm: number;
  serviceTypes: string[];
  contactEmail: string;
  vatId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredVehicle {
  id: string;
  providerId: string;
  registrationHash: string;
  vehicleClass: VehicleClass;
  payloadKg: number;
  volumeM3: number;
  active: boolean;
  createdAt: Date;
}

export interface StoredDocument {
  id: string;
  providerId: string;
  type: string;
  status: DocumentStatus;
  storageKey: string;
  expiresAt: Date | null;
  reviewedAt: Date | null;
  createdAt: Date;
}

export interface StoredQuote {
  id: string;
  jobId: string;
  organizationId: string;
  status: QuoteStatus;
  netCents: number;
  vatCents: number;
  grossCents: number;
  vatRateBasisPoints: number;
  currency: "EUR";
  breakdown: { label: string; netCents: number }[] | null;
  notes: string | null;
  validUntil: Date;
  approvedAt: Date | null;
  approvedByUserId: string | null;
  createdAt: Date;
}

export interface StoredOffer {
  id: string;
  jobId: string;
  providerId: string;
  status: OfferStatus;
  payoutNetCents: number;
  currency: "EUR";
  expiresAt: Date;
  respondedAt: Date | null;
  declineReason: string | null;
  createdAt: Date;
}

export interface StoredAssignment {
  id: string;
  jobId: string;
  providerId: string;
  status: "ACTIVE" | "FELL_THROUGH" | "COMPLETED";
  payoutNetCents: number;
  currency: "EUR";
  acceptedAt: Date;
  completedAt: Date | null;
}

export interface StoredEvidence {
  id: string;
  jobId: string;
  kind: EvidenceKind;
  status: "REQUESTED" | "UPLOADED" | "REJECTED";
  mimeType: string;
  sizeBytes: number;
  storageKey: string;
  uploadedByUserId: string | null;
  createdAt: Date;
}

export interface StoredJobEvent {
  id: string;
  jobId: string;
  actorId: string | null;
  type: string;
  payload: Record<string, unknown>;
  correlationId: string | null;
  createdAt: Date;
}

export interface StoredIdempotencyRecord {
  key: string;
  organizationId: string;
  method: string;
  path: string;
  requestHash: string;
  statusCode: number;
  responseBody: unknown;
  expiresAt: Date;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface TransitionInput {
  jobId: string;
  scope: Scope;
  to: JobStatus;
  actor: Actor;
  eventType: string;
  payload?: Record<string, unknown>;
  approved?: {
    vehicleClass: VehicleClass;
    workers: number;
    circularRoute: CircularRoute;
  };
}

export interface AcceptOfferResult {
  offer: StoredOffer;
  assignment: StoredAssignment;
  job: Job;
}

export interface Store {
  /* ------------------------------------------------------------- identity */
  findUserBySubject(subject: string): Promise<StoredUser | null>;

  /* ----------------------------------------------------------------- jobs */
  createJob(params: { organizationId: string; input: CreateJobInput; actor: Actor }): Promise<Job>;
  findJob(id: string, scope: Scope): Promise<Job | null>;
  listJobs(params: {
    scope: Scope;
    status?: JobStatus;
    limit: number;
    cursor?: string;
  }): Promise<Page<Job>>;
  /** Status change, job event and audit record in one transaction. */
  transitionJob(input: TransitionInput): Promise<Job>;
  listJobEvents(jobId: string, scope: Scope): Promise<StoredJobEvent[]>;

  /* ------------------------------------------------------------ providers */
  createProvider(params: {
    input: CreateProviderInput;
    actor: Actor;
    ownerUserId: string;
  }): Promise<StoredProvider>;
  findProvider(id: string): Promise<StoredProvider | null>;
  listProviders(params: { status?: ProviderStatus }): Promise<StoredProvider[]>;
  setProviderStatus(params: {
    providerId: string;
    status: ProviderStatus;
    reason: string;
    actor: Actor;
  }): Promise<StoredProvider>;

  createVehicle(params: {
    providerId: string;
    input: CreateVehicleInput;
    registrationHash: string;
    actor: Actor;
  }): Promise<StoredVehicle>;
  listVehicles(providerId: string): Promise<StoredVehicle[]>;

  createDocument(params: {
    providerId: string;
    input: CreateProviderDocumentInput;
    actor: Actor;
  }): Promise<StoredDocument>;
  listDocuments(providerId: string): Promise<StoredDocument[]>;
  reviewDocument(params: {
    documentId: string;
    status: "VERIFIED" | "REJECTED";
    reason: string;
    actor: Actor;
  }): Promise<StoredDocument>;

  /* --------------------------------------------------------------- quotes */
  createQuote(params: {
    jobId: string;
    organizationId: string;
    netCents: number;
    vatCents: number;
    grossCents: number;
    vatRateBasisPoints: number;
    breakdown: { label: string; netCents: number }[] | null;
    notes: string | null;
    validUntil: Date;
    actor: Actor;
  }): Promise<StoredQuote>;
  findQuote(id: string, scope: Scope): Promise<StoredQuote | null>;
  listQuotesForJob(jobId: string, scope: Scope): Promise<StoredQuote[]>;
  /** Approval or rejection with the resulting job transition, atomically. */
  decideQuote(params: {
    quoteId: string;
    scope: Scope;
    decision: "APPROVE" | "REJECT";
    reason?: string;
    actor: Actor;
  }): Promise<{ quote: StoredQuote; job: Job }>;

  /* ---------------------------------------------------------- assignments */
  createOffers(params: {
    jobId: string;
    providerIds: string[];
    payoutNetCents: number;
    expiresAt: Date;
    actor: Actor;
  }): Promise<StoredOffer[]>;
  listOffersForJob(jobId: string): Promise<StoredOffer[]>;
  listOffersForProvider(params: { providerId: string; status?: OfferStatus }): Promise<StoredOffer[]>;
  findOffer(id: string): Promise<StoredOffer | null>;
  /**
   * Accepts an offer if and only if it is still PENDING, unexpired, and no
   * other provider already holds the job. Implementations must make this
   * atomic; two providers accepting simultaneously must produce exactly one
   * winner.
   */
  acceptOffer(params: { offerId: string; providerId: string; now: Date; actor: Actor }): Promise<AcceptOfferResult>;
  declineOffer(params: {
    offerId: string;
    providerId: string;
    reason?: string;
    actor: Actor;
  }): Promise<StoredOffer>;
  /** Marks every PENDING offer past `now` as EXPIRED. Returns how many. */
  expireOffers(now: Date, actor: Actor): Promise<number>;
  findActiveAssignment(jobId: string): Promise<StoredAssignment | null>;
  /** Releases the active assignment and returns the job to TRIAGED. */
  fallbackAssignment(params: { jobId: string; reason: string; actor: Actor }): Promise<Job>;

  /* ------------------------------------------------------------- evidence */
  createEvidence(params: {
    jobId: string;
    kind: EvidenceKind;
    mimeType: string;
    sizeBytes: number;
    storageKey: string;
    actor: Actor;
  }): Promise<StoredEvidence>;
  markEvidenceUploaded(params: {
    evidenceId: string;
    actor: Actor;
  }): Promise<StoredEvidence>;
  listEvidence(jobId: string, scope: Scope): Promise<StoredEvidence[]>;

  /* ---------------------------------------------------------- idempotency */
  findIdempotencyRecord(organizationId: string, key: string): Promise<StoredIdempotencyRecord | null>;
  saveIdempotencyRecord(record: StoredIdempotencyRecord): Promise<void>;

  /* ------------------------------------------------------------ lifecycle */
  close(): Promise<void>;
}
