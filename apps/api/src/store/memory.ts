import { canTransition, type CreateJobInput, type Job, type JobStatus } from "@rescue/contracts";
import { newId } from "../lib/crypto.js";
import { outboxForEvent } from "../lib/outbox.js";
import { AppError, conflict, invalidTransition, notFound } from "../lib/errors.js";
import type {
  AcceptOfferResult,
  Actor,
  Page,
  Scope,
  StoredAssignment,
  StoredDocument,
  StoredEvidence,
  StoredIdempotencyRecord,
  StoredJobEvent,
  StoredLedgerEntry,
  StoredOffer,
  StoredOutboxMessage,
  StoredProvider,
  StoredQuote,
  StoredSuggestion,
  StoredUser,
  StoredVehicle,
  Store,
  TransitionInput
} from "./types.js";

/**
 * In-memory Store.
 *
 * This is the implementation the test suite runs against, and the default when
 * no DATABASE_URL is configured so the API is runnable without a database. It
 * is not a production store: everything is lost on restart and nothing is
 * shared between processes.
 *
 * It enforces exactly the same tenant rules and state machine as the Prisma
 * implementation, because the same conformance suite runs against both.
 */

interface JobRecord {
  id: string;
  organizationId: string;
  status: JobStatus;
  input: CreateJobInput;
  approvedVehicleClass: string | null;
  approvedWorkers: number | null;
  approvedCircularRoute: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditRecord {
  id: string;
  actorId: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
  correlationId: string | null;
  createdAt: Date;
}

export interface MemorySeed {
  organizations?: { id: string; name: string }[];
  users?: StoredUser[];
  providers?: (Omit<StoredProvider, "createdAt" | "updatedAt" | "acceptingWork" | "availabilityNote"> & {
    acceptingWork?: boolean;
    availabilityNote?: string | null;
    vehicles?: (Omit<StoredVehicle, "providerId" | "createdAt" | "registrationHash"> & {
      registrationHash?: string;
    })[];
    documents?: Omit<StoredDocument, "providerId" | "createdAt" | "reviewedAt">[];
  })[];
}

export class MemoryStore implements Store {
  private readonly organizations = new Map<string, { id: string; name: string }>();
  private readonly users = new Map<string, StoredUser>();
  private readonly jobs = new Map<string, JobRecord>();
  private readonly providers = new Map<string, StoredProvider>();
  private readonly vehicles = new Map<string, StoredVehicle>();
  private readonly documents = new Map<string, StoredDocument>();
  private readonly quotes = new Map<string, StoredQuote>();
  private readonly offers = new Map<string, StoredOffer>();
  private readonly assignments = new Map<string, StoredAssignment>();
  private readonly evidence = new Map<string, StoredEvidence>();
  private readonly idempotency = new Map<string, StoredIdempotencyRecord>();
  private readonly outbox = new Map<string, StoredOutboxMessage>();
  /** dedupeKey -> id, so a second enqueue of the same intent is a no-op. */
  private readonly outboxKeys = new Map<string, string>();
  private readonly ledger: StoredLedgerEntry[] = [];
  private readonly suggestions: StoredSuggestion[] = [];

  /** Append-only, like the database tables they mirror. Exposed for tests. */
  readonly events: StoredJobEvent[] = [];
  readonly audit: AuditRecord[] = [];

  /**
   * Serialises the read-modify-write of offer acceptance per job. Node is
   * single-threaded but `await` interleaves, so two concurrent accepts can
   * both observe "no assignment yet" without this.
   */
  private readonly jobLocks = new Map<string, Promise<unknown>>();

  constructor(seed: MemorySeed = {}) {
    for (const organization of seed.organizations ?? []) {
      this.organizations.set(organization.id, organization);
    }
    for (const user of seed.users ?? []) {
      this.users.set(user.subject, user);
    }
    for (const provider of seed.providers ?? []) {
      const { vehicles = [], documents = [], ...rest } = provider;
      this.providers.set(provider.id, {
        ...rest,
        acceptingWork: rest.acceptingWork ?? true,
        availabilityNote: rest.availabilityNote ?? null,
        createdAt: new Date(0),
        updatedAt: new Date(0)
      });
      for (const vehicle of vehicles) {
        this.vehicles.set(vehicle.id, {
          ...vehicle,
          registrationHash: vehicle.registrationHash ?? `seed-${vehicle.id}`,
          providerId: provider.id,
          createdAt: new Date(0)
        });
      }
      for (const document of documents) {
        this.documents.set(document.id, {
          ...document,
          providerId: provider.id,
          reviewedAt: null,
          createdAt: new Date(0)
        });
      }
    }
  }

  /* ---------------------------------------------------------------- utils */

  private async withJobLock<T>(jobId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.jobLocks.get(jobId) ?? Promise.resolve();
    const current = previous.then(work, work);
    this.jobLocks.set(
      jobId,
      current.catch(() => undefined)
    );
    return current;
  }

  private toJob(record: JobRecord): Job {
    return {
      ...record.input,
      id: record.id,
      organizationId: record.organizationId,
      status: record.status,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString()
    };
  }

  private visible(record: JobRecord, scope: Scope): boolean {
    if (scope.kind === "staff") return true;
    if (scope.kind === "organization") return record.organizationId === scope.organizationId;
    // A provider sees a job once it has an assignment on it, and keeps seeing
    // it afterwards so its own completed work stays readable.
    return [...this.assignments.values()].some(
      (assignment) => assignment.jobId === record.id && assignment.providerId === scope.providerId
    );
  }

  private requireJob(jobId: string, scope: Scope): JobRecord {
    const record = this.jobs.get(jobId);
    // A record in another tenant is reported as absent, never as forbidden.
    if (!record || !this.visible(record, scope)) throw notFound("Job");
    return record;
  }

  private recordAudit(
    actor: Actor,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown> = {}
  ): void {
    this.audit.push({
      id: newId(),
      actorId: actor.userId,
      actorRole: actor.role,
      action,
      entityType,
      entityId,
      metadata,
      correlationId: actor.correlationId ?? null,
      createdAt: new Date()
    });
  }

  private recordEvent(
    jobId: string,
    actor: Actor,
    type: string,
    payload: Record<string, unknown> = {}
  ): void {
    this.events.push({
      id: newId(),
      jobId,
      actorId: actor.userId,
      type,
      payload,
      correlationId: actor.correlationId ?? null,
      createdAt: new Date()
    });

    // The outbox is a projection of this stream, written here so it cannot be
    // forgotten at a call site and cannot exist for an event that did not.
    const draft = outboxForEvent({ jobId, type, payload });
    if (draft && !this.outboxKeys.has(draft.dedupeKey)) {
      const id = newId();
      this.outboxKeys.set(draft.dedupeKey, id);
      this.outbox.set(id, {
        id,
        topic: draft.topic,
        dedupeKey: draft.dedupeKey,
        jobId: draft.jobId,
        payload: draft.payload,
        status: "PENDING",
        attempts: 0,
        availableAt: new Date(0),
        lastError: null,
        createdAt: new Date(),
        deliveredAt: null
      });
    }
  }

  /* ------------------------------------------------------------- identity */

  async findUserBySubject(subject: string): Promise<StoredUser | null> {
    return this.users.get(subject) ?? null;
  }

  /* ----------------------------------------------------------------- jobs */

  async createJob(params: { organizationId: string; input: CreateJobInput; actor: Actor }): Promise<Job> {
    const now = new Date();
    const record: JobRecord = {
      id: newId(),
      organizationId: params.organizationId,
      status: "DRAFT",
      input: params.input,
      approvedVehicleClass: null,
      approvedWorkers: null,
      approvedCircularRoute: null,
      createdAt: now,
      updatedAt: now
    };
    this.jobs.set(record.id, record);
    this.recordEvent(record.id, params.actor, "JOB_CREATED", { type: params.input.type });
    this.recordAudit(params.actor, "JOB_CREATED", "Job", record.id, {
      organizationId: params.organizationId
    });
    return this.toJob(record);
  }

  async findJob(id: string, scope: Scope): Promise<Job | null> {
    const record = this.jobs.get(id);
    if (!record || !this.visible(record, scope)) return null;
    return this.toJob(record);
  }

  async listJobs(params: {
    scope: Scope;
    status?: JobStatus;
    limit: number;
    cursor?: string;
  }): Promise<Page<Job>> {
    const all = [...this.jobs.values()]
      .filter((record) => this.visible(record, params.scope))
      .filter((record) => !params.status || record.status === params.status)
      .sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1)
      );

    const start = params.cursor ? all.findIndex((record) => record.id === params.cursor) + 1 : 0;
    const slice = all.slice(start, start + params.limit);
    const nextCursor = start + params.limit < all.length ? (slice.at(-1)?.id ?? null) : null;
    return { items: slice.map((record) => this.toJob(record)), nextCursor };
  }

  async transitionJob(input: TransitionInput): Promise<Job> {
    return this.withJobLock(input.jobId, async () => {
      const record = this.requireJob(input.jobId, input.scope);
      if (!canTransition(record.status, input.to)) {
        throw invalidTransition(record.status, input.to);
      }
      const from = record.status;
      record.status = input.to;
      record.updatedAt = new Date();
      if (input.approved) {
        record.approvedVehicleClass = input.approved.vehicleClass;
        record.approvedWorkers = input.approved.workers;
        record.approvedCircularRoute = input.approved.circularRoute;
      }
      this.recordEvent(record.id, input.actor, input.eventType, {
        from,
        to: input.to,
        ...input.payload
      });
      this.recordAudit(input.actor, input.eventType, "Job", record.id, {
        from,
        to: input.to,
        ...input.payload
      });
      return this.toJob(record);
    });
  }

  async listJobEvents(jobId: string, scope: Scope): Promise<StoredJobEvent[]> {
    this.requireJob(jobId, scope);
    return this.events
      .filter((event) => event.jobId === jobId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  /* ------------------------------------------------------------ providers */

  async createProvider(params: {
    input: Parameters<Store["createProvider"]>[0]["input"];
    actor: Actor;
    ownerUserId: string;
  }): Promise<StoredProvider> {
    const now = new Date();
    const provider: StoredProvider = {
      id: newId(),
      legalName: params.input.legalName,
      status: "PENDING",
      // A new provider is willing by default; it is RESCUE's vetting, not the
      // provider's own switch, that keeps it out of dispatch until approved.
      acceptingWork: true,
      availabilityNote: null,
      basePostalCode: params.input.basePostalCode,
      serviceRadiusKm: params.input.serviceRadiusKm,
      serviceTypes: [...params.input.serviceTypes],
      contactEmail: params.input.contactEmail,
      vatId: params.input.vatId ?? null,
      createdAt: now,
      updatedAt: now
    };
    this.providers.set(provider.id, provider);
    this.recordAudit(params.actor, "PROVIDER_CREATED", "Provider", provider.id, {
      legalName: provider.legalName
    });
    return provider;
  }

  async findProvider(id: string): Promise<StoredProvider | null> {
    return this.providers.get(id) ?? null;
  }

  async listProviders(params: { status?: Parameters<Store["listProviders"]>[0]["status"] }) {
    return [...this.providers.values()]
      .filter((provider) => !params.status || provider.status === params.status)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  async setProviderStatus(params: {
    providerId: string;
    status: StoredProvider["status"];
    reason: string;
    actor: Actor;
  }): Promise<StoredProvider> {
    const provider = this.providers.get(params.providerId);
    if (!provider) throw notFound("Provider");
    const from = provider.status;
    provider.status = params.status;
    provider.updatedAt = new Date();
    this.recordAudit(params.actor, "PROVIDER_STATUS_CHANGED", "Provider", provider.id, {
      from,
      to: params.status,
      reason: params.reason
    });
    return provider;
  }

  async setProviderAvailability(params: {
    providerId: string;
    acceptingWork: boolean;
    note: string | null;
    actor: Actor;
  }): Promise<StoredProvider> {
    const provider = this.providers.get(params.providerId);
    if (!provider) throw notFound("Provider");
    const from = provider.acceptingWork;
    provider.acceptingWork = params.acceptingWork;
    // A note only explains a pause. Resuming clears it, so a stale "van in the
    // workshop" cannot linger next to a provider that is taking work again.
    provider.availabilityNote = params.acceptingWork ? null : params.note;
    provider.updatedAt = new Date();
    this.recordAudit(params.actor, "PROVIDER_AVAILABILITY_CHANGED", "Provider", provider.id, {
      from,
      to: params.acceptingWork,
      note: provider.availabilityNote
    });
    return provider;
  }

  async createVehicle(params: {
    providerId: string;
    input: Parameters<Store["createVehicle"]>[0]["input"];
    registrationHash: string;
    actor: Actor;
  }): Promise<StoredVehicle> {
    if (!this.providers.has(params.providerId)) throw notFound("Provider");
    const duplicate = [...this.vehicles.values()].some(
      (vehicle) =>
        vehicle.providerId === params.providerId &&
        vehicle.registrationHash === params.registrationHash
    );
    if (duplicate) throw conflict("This vehicle is already registered to the provider");

    const vehicle: StoredVehicle = {
      id: newId(),
      providerId: params.providerId,
      registrationHash: params.registrationHash,
      vehicleClass: params.input.vehicleClass,
      payloadKg: params.input.payloadKg,
      volumeM3: params.input.volumeM3,
      active: params.input.active,
      createdAt: new Date()
    };
    this.vehicles.set(vehicle.id, vehicle);
    this.recordAudit(params.actor, "VEHICLE_ADDED", "Vehicle", vehicle.id, {
      providerId: params.providerId
    });
    return vehicle;
  }

  async listVehicles(providerId: string): Promise<StoredVehicle[]> {
    return [...this.vehicles.values()].filter((vehicle) => vehicle.providerId === providerId);
  }

  async createDocument(params: {
    providerId: string;
    input: Parameters<Store["createDocument"]>[0]["input"];
    actor: Actor;
  }): Promise<StoredDocument> {
    if (!this.providers.has(params.providerId)) throw notFound("Provider");
    const document: StoredDocument = {
      id: newId(),
      providerId: params.providerId,
      type: params.input.type,
      status: "PENDING",
      storageKey: params.input.storageKey,
      expiresAt: params.input.expiresAt ? new Date(params.input.expiresAt) : null,
      reviewedAt: null,
      createdAt: new Date()
    };
    this.documents.set(document.id, document);
    this.recordAudit(params.actor, "DOCUMENT_SUBMITTED", "ProviderDocument", document.id, {
      providerId: params.providerId,
      type: document.type
    });
    return document;
  }

  async listDocuments(providerId: string): Promise<StoredDocument[]> {
    return [...this.documents.values()].filter((document) => document.providerId === providerId);
  }

  async reviewDocument(params: {
    documentId: string;
    status: "VERIFIED" | "REJECTED";
    reason: string;
    actor: Actor;
  }): Promise<StoredDocument> {
    const document = this.documents.get(params.documentId);
    if (!document) throw notFound("Document");
    document.status = params.status;
    document.reviewedAt = new Date();
    this.recordAudit(params.actor, "DOCUMENT_REVIEWED", "ProviderDocument", document.id, {
      status: params.status,
      reason: params.reason
    });
    return document;
  }

  /* --------------------------------------------------------------- quotes */

  async createQuote(params: Parameters<Store["createQuote"]>[0]): Promise<StoredQuote> {
    const quote: StoredQuote = {
      id: newId(),
      jobId: params.jobId,
      organizationId: params.organizationId,
      status: "SENT",
      netCents: params.netCents,
      vatCents: params.vatCents,
      grossCents: params.grossCents,
      vatRateBasisPoints: params.vatRateBasisPoints,
      currency: "EUR",
      breakdown: params.breakdown,
      notes: params.notes,
      validUntil: params.validUntil,
      approvedAt: null,
      approvedByUserId: null,
      createdAt: new Date()
    };
    this.quotes.set(quote.id, quote);
    this.recordEvent(params.jobId, params.actor, "QUOTE_SENT", {
      quoteId: quote.id,
      grossCents: quote.grossCents
    });
    this.recordAudit(params.actor, "QUOTE_SENT", "Quote", quote.id, {
      jobId: params.jobId,
      grossCents: quote.grossCents
    });
    return quote;
  }

  async findQuote(id: string, scope: Scope): Promise<StoredQuote | null> {
    const quote = this.quotes.get(id);
    if (!quote) return null;
    if (scope.kind === "organization" && quote.organizationId !== scope.organizationId) return null;
    // Pricing is between RESCUE and the customer; a provider sees its payout,
    // never what the customer was charged.
    if (scope.kind === "provider") return null;
    return quote;
  }

  async listQuotesForJob(jobId: string, scope: Scope): Promise<StoredQuote[]> {
    this.requireJob(jobId, scope);
    // Pricing is between RESCUE and the customer. A provider can see the job
    // and its own payout, never what the customer agreed to pay.
    if (scope.kind === "provider") return [];
    return [...this.quotes.values()].filter((quote) => quote.jobId === jobId);
  }

  async decideQuote(params: {
    quoteId: string;
    scope: Scope;
    decision: "APPROVE" | "REJECT";
    reason?: string;
    actor: Actor;
  }): Promise<{ quote: StoredQuote; job: Job }> {
    const quote = await this.findQuote(params.quoteId, params.scope);
    if (!quote) throw notFound("Quote");
    if (quote.status !== "SENT") {
      throw conflict(`This quote is ${quote.status.toLowerCase()} and can no longer be decided`);
    }
    if (quote.validUntil.getTime() <= Date.now()) {
      quote.status = "EXPIRED";
      throw conflict("This quote has expired");
    }

    quote.status = params.decision === "APPROVE" ? "APPROVED" : "REJECTED";
    if (params.decision === "APPROVE") {
      quote.approvedAt = new Date();
      quote.approvedByUserId = params.actor.userId;
    }

    const record = this.requireJob(quote.jobId, params.scope);
    this.recordEvent(quote.jobId, params.actor, `QUOTE_${quote.status}`, {
      quoteId: quote.id,
      reason: params.reason
    });
    this.recordAudit(params.actor, `QUOTE_${quote.status}`, "Quote", quote.id, {
      jobId: quote.jobId,
      reason: params.reason
    });
    return { quote, job: this.toJob(record) };
  }

  /* ---------------------------------------------------------- assignments */

  async createOffers(params: {
    jobId: string;
    providerIds: string[];
    payoutNetCents: number;
    expiresAt: Date;
    actor: Actor;
  }): Promise<StoredOffer[]> {
    const created: StoredOffer[] = [];
    for (const providerId of params.providerIds) {
      const existing = [...this.offers.values()].find(
        (offer) => offer.jobId === params.jobId && offer.providerId === providerId
      );
      if (existing) continue;
      const offer: StoredOffer = {
        id: newId(),
        jobId: params.jobId,
        providerId,
        status: "PENDING",
        payoutNetCents: params.payoutNetCents,
        currency: "EUR",
        expiresAt: params.expiresAt,
        respondedAt: null,
        declineReason: null,
        createdAt: new Date()
      };
      this.offers.set(offer.id, offer);
      created.push(offer);
    }
    this.recordEvent(params.jobId, params.actor, "OFFERS_SENT", {
      providerCount: created.length,
      payoutNetCents: params.payoutNetCents
    });
    this.recordAudit(params.actor, "OFFERS_SENT", "Job", params.jobId, {
      providerIds: created.map((offer) => offer.providerId)
    });
    return created;
  }

  async listOffersForJob(jobId: string): Promise<StoredOffer[]> {
    return [...this.offers.values()].filter((offer) => offer.jobId === jobId);
  }

  async listOffersForProvider(params: {
    providerId: string;
    status?: StoredOffer["status"];
  }): Promise<StoredOffer[]> {
    return [...this.offers.values()].filter(
      (offer) => offer.providerId === params.providerId && (!params.status || offer.status === params.status)
    );
  }

  async findOffer(id: string): Promise<StoredOffer | null> {
    return this.offers.get(id) ?? null;
  }

  async acceptOffer(params: {
    offerId: string;
    providerId: string;
    now: Date;
    actor: Actor;
  }): Promise<AcceptOfferResult> {
    const candidate = this.offers.get(params.offerId);
    if (!candidate || candidate.providerId !== params.providerId) throw notFound("Offer");

    return this.withJobLock(candidate.jobId, async () => {
      const offer = this.offers.get(params.offerId)!;
      if (offer.status === "EXPIRED" || offer.expiresAt.getTime() <= params.now.getTime()) {
        offer.status = "EXPIRED";
        throw new AppError(409, "OFFER_EXPIRED", "This offer has expired");
      }
      if (offer.status !== "PENDING") {
        throw new AppError(409, "OFFER_ALREADY_TAKEN", "This offer is no longer open");
      }
      const alreadyAssigned = [...this.assignments.values()].find(
        (assignment) => assignment.jobId === offer.jobId && assignment.status === "ACTIVE"
      );
      if (alreadyAssigned) {
        offer.status = "WITHDRAWN";
        throw new AppError(409, "OFFER_ALREADY_TAKEN", "Another provider has already accepted this job");
      }

      const record = this.jobs.get(offer.jobId);
      if (!record) throw notFound("Job");
      if (!canTransition(record.status, "ASSIGNED")) {
        throw invalidTransition(record.status, "ASSIGNED");
      }

      offer.status = "ACCEPTED";
      offer.respondedAt = params.now;

      const assignment: StoredAssignment = {
        id: newId(),
        jobId: offer.jobId,
        providerId: offer.providerId,
        status: "ACTIVE",
        payoutNetCents: offer.payoutNetCents,
        currency: "EUR",
        acceptedAt: params.now,
        completedAt: null
      };
      this.assignments.set(assignment.id, assignment);

      // Every other open offer for this job is withdrawn in the same step.
      for (const other of this.offers.values()) {
        if (other.jobId === offer.jobId && other.id !== offer.id && other.status === "PENDING") {
          other.status = "WITHDRAWN";
          other.respondedAt = params.now;
        }
      }

      const from = record.status;
      record.status = "ASSIGNED";
      record.updatedAt = params.now;

      this.recordEvent(record.id, params.actor, "OFFER_ACCEPTED", {
        from,
        to: "ASSIGNED",
        offerId: offer.id,
        providerId: offer.providerId
      });
      this.recordAudit(params.actor, "OFFER_ACCEPTED", "Assignment", assignment.id, {
        jobId: record.id,
        providerId: offer.providerId,
        payoutNetCents: offer.payoutNetCents
      });

      return { offer, assignment, job: this.toJob(record) };
    });
  }

  async declineOffer(params: {
    offerId: string;
    providerId: string;
    reason?: string;
    actor: Actor;
  }): Promise<StoredOffer> {
    const offer = this.offers.get(params.offerId);
    if (!offer || offer.providerId !== params.providerId) throw notFound("Offer");
    if (offer.status !== "PENDING") throw conflict("This offer is no longer open");
    offer.status = "DECLINED";
    offer.respondedAt = new Date();
    offer.declineReason = params.reason ?? null;
    this.recordEvent(offer.jobId, params.actor, "OFFER_DECLINED", {
      offerId: offer.id,
      providerId: offer.providerId
    });
    this.recordAudit(params.actor, "OFFER_DECLINED", "AssignmentOffer", offer.id, {
      jobId: offer.jobId,
      reason: params.reason
    });
    return offer;
  }

  async expireOffers(now: Date, actor: Actor): Promise<{ expired: number; jobIds: string[] }> {
    let expired = 0;
    const jobIds = new Set<string>();
    for (const offer of this.offers.values()) {
      if (offer.status === "PENDING" && offer.expiresAt.getTime() <= now.getTime()) {
        offer.status = "EXPIRED";
        offer.respondedAt = now;
        expired++;
        jobIds.add(offer.jobId);
        this.recordEvent(offer.jobId, actor, "OFFER_EXPIRED", { offerId: offer.id });
      }
    }
    if (expired > 0) {
      this.recordAudit(actor, "OFFERS_EXPIRED", "AssignmentOffer", "sweep", { count: expired });
    }
    return { expired, jobIds: [...jobIds] };
  }

  async findActiveAssignment(jobId: string): Promise<StoredAssignment | null> {
    return (
      [...this.assignments.values()].find(
        (assignment) => assignment.jobId === jobId && assignment.status === "ACTIVE"
      ) ?? null
    );
  }

  async fallbackAssignment(params: { jobId: string; reason: string; actor: Actor }): Promise<Job> {
    return this.withJobLock(params.jobId, async () => {
      const record = this.jobs.get(params.jobId);
      if (!record) throw notFound("Job");
      const assignment = [...this.assignments.values()].find(
        (candidate) => candidate.jobId === params.jobId && candidate.status === "ACTIVE"
      );
      if (!assignment) throw conflict("This job has no active assignment");
      // Back to QUOTED, not TRIAGED: the approved price still stands and the
      // job only needs a different provider. See ADR 0001.
      if (!canTransition(record.status, "QUOTED")) {
        throw invalidTransition(record.status, "QUOTED");
      }

      assignment.status = "FELL_THROUGH";
      const from = record.status;
      record.status = "QUOTED";
      record.updatedAt = new Date();

      this.recordEvent(record.id, params.actor, "ASSIGNMENT_FELL_THROUGH", {
        from,
        to: "QUOTED",
        providerId: assignment.providerId,
        reason: params.reason
      });
      this.recordAudit(params.actor, "ASSIGNMENT_FELL_THROUGH", "Assignment", assignment.id, {
        jobId: record.id,
        reason: params.reason
      });
      return this.toJob(record);
    });
  }

  /* ------------------------------------------------------------- evidence */

  async createEvidence(params: {
    jobId: string;
    kind: StoredEvidence["kind"];
    mimeType: string;
    sizeBytes: number;
    storageKey: string;
    actor: Actor;
  }): Promise<StoredEvidence> {
    const evidence: StoredEvidence = {
      id: newId(),
      jobId: params.jobId,
      kind: params.kind,
      status: "REQUESTED",
      mimeType: params.mimeType,
      sizeBytes: params.sizeBytes,
      storageKey: params.storageKey,
      uploadedByUserId: null,
      createdAt: new Date()
    };
    this.evidence.set(evidence.id, evidence);
    this.recordAudit(params.actor, "EVIDENCE_REQUESTED", "Evidence", evidence.id, {
      jobId: params.jobId,
      kind: params.kind
    });
    return evidence;
  }

  async markEvidenceUploaded(params: { evidenceId: string; actor: Actor }): Promise<StoredEvidence> {
    const evidence = this.evidence.get(params.evidenceId);
    if (!evidence) throw notFound("Evidence");
    evidence.status = "UPLOADED";
    evidence.uploadedByUserId = params.actor.userId;
    this.recordEvent(evidence.jobId, params.actor, "EVIDENCE_UPLOADED", {
      evidenceId: evidence.id,
      kind: evidence.kind
    });
    this.recordAudit(params.actor, "EVIDENCE_UPLOADED", "Evidence", evidence.id, {
      jobId: evidence.jobId
    });
    return evidence;
  }

  async listEvidence(jobId: string, scope: Scope): Promise<StoredEvidence[]> {
    this.requireJob(jobId, scope);
    return [...this.evidence.values()].filter((evidence) => evidence.jobId === jobId);
  }

  async findEvidence(evidenceId: string, scope: Scope): Promise<StoredEvidence | null> {
    const evidence = this.evidence.get(evidenceId);
    if (!evidence) return null;
    // Reached through the job, so the tenant rule is the job's rule and there
    // is no second place for it to drift.
    const job = this.jobs.get(evidence.jobId);
    if (!job || !this.visible(job, scope)) return null;
    return evidence;
  }

  async recordJobEvent(params: {
    jobId: string;
    type: string;
    payload?: Record<string, unknown>;
    actor: Actor;
  }): Promise<void> {
    if (!this.jobs.has(params.jobId)) throw notFound("Job");
    this.recordEvent(params.jobId, params.actor, params.type, params.payload ?? {});
  }

  /* --------------------------------------------------------------- outbox */

  async claimOutbox(params: { now: Date; limit: number }): Promise<StoredOutboxMessage[]> {
    const due = [...this.outbox.values()]
      .filter(
        (message) =>
          (message.status === "PENDING" || message.status === "FAILED") &&
          message.availableAt.getTime() <= params.now.getTime()
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, params.limit);

    // Claiming pushes the row out of reach for a while, so a second poll
    // before the first finishes does not hand the same message out twice.
    // The Prisma store gets this from SKIP LOCKED; here it is explicit.
    for (const message of due) {
      message.availableAt = new Date(params.now.getTime() + 60_000);
    }
    return due.map((message) => ({ ...message }));
  }

  async markOutboxDelivered(params: { id: string; now: Date }): Promise<void> {
    const message = this.outbox.get(params.id);
    if (!message) return;
    message.status = "SENT";
    message.deliveredAt = params.now;
    message.lastError = null;
  }

  async markOutboxFailed(params: {
    id: string;
    error: string;
    now: Date;
    retryAt: Date | null;
  }): Promise<void> {
    const message = this.outbox.get(params.id);
    if (!message) return;
    message.attempts += 1;
    message.lastError = params.error.slice(0, 500);
    // No retry time means we have stopped trying. The row stays, because a
    // dead letter that deletes itself is a lost delivery nobody can find.
    message.status = params.retryAt ? "FAILED" : "DEAD";
    message.availableAt = params.retryAt ?? message.availableAt;
  }

  async listOutbox(params: {
    jobId?: string;
    status?: StoredOutboxMessage["status"];
  }): Promise<StoredOutboxMessage[]> {
    return [...this.outbox.values()]
      .filter((message) => !params.jobId || message.jobId === params.jobId)
      .filter((message) => !params.status || message.status === params.status)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((message) => ({ ...message }));
  }

  async outboxStats(): Promise<{
    byStatus: Record<StoredOutboxMessage["status"], number>;
    oldestUndelivered: Date | null;
  }> {
    const byStatus = { PENDING: 0, SENT: 0, FAILED: 0, DEAD: 0 };
    let oldestUndelivered: Date | null = null;
    for (const message of this.outbox.values()) {
      byStatus[message.status] += 1;
      // DEAD counts as undelivered: it is the oldest thing that never
      // happened, and hiding it here would make the age metric look healthy
      // precisely when it is not.
      if (message.status === "SENT") continue;
      if (!oldestUndelivered || message.createdAt < oldestUndelivered) {
        oldestUndelivered = message.createdAt;
      }
    }
    return { byStatus, oldestUndelivered };
  }

  /* --------------------------------------------------------------- ledger */

  async appendLedgerEntries(params: {
    entries: {
      jobId: string;
      kind: StoredLedgerEntry["kind"];
      amountCents: number;
      externalReference?: string | null;
      note?: string | null;
    }[];
    actor: Actor;
  }): Promise<StoredLedgerEntry[]> {
    const written: StoredLedgerEntry[] = [];
    for (const entry of params.entries) {
      // The same rules the database enforces, enforced here too, so the two
      // stores refuse the same nonsense rather than one of them accepting it.
      if (entry.amountCents === 0) throw new AppError(422, "VALIDATION_ERROR", "A ledger entry cannot be zero");
      const mustBePositive = ["AUTHORISATION", "CAPTURE", "PAYOUT_REVERSAL"].includes(entry.kind);
      if (mustBePositive !== entry.amountCents > 0) {
        throw new AppError(
          422,
          "VALIDATION_ERROR",
          `A ${entry.kind} entry must be ${mustBePositive ? "positive" : "negative"}`
        );
      }
      const record: StoredLedgerEntry = {
        id: newId(),
        jobId: entry.jobId,
        kind: entry.kind,
        amountCents: entry.amountCents,
        currency: "EUR",
        externalReference: entry.externalReference ?? null,
        note: entry.note ?? null,
        createdAt: new Date()
      };
      this.ledger.push(record);
      written.push(record);
      this.recordAudit(params.actor, "LEDGER_ENTRY_APPENDED", "LedgerEntry", record.id, {
        jobId: record.jobId,
        kind: record.kind,
        amountCents: record.amountCents
      });
    }
    return written;
  }

  async listLedger(jobId: string, scope: Scope): Promise<StoredLedgerEntry[]> {
    this.requireJob(jobId, scope);
    return this.ledger.filter((entry) => entry.jobId === jobId).map((entry) => ({ ...entry }));
  }

  /* ---------------------------------------------------------- suggestions */

  async recordSuggestion(params: {
    jobId: string;
    kind: string;
    output: unknown;
    provenance: StoredSuggestion extends never ? never : Parameters<Store["recordSuggestion"]>[0]["provenance"];
  }): Promise<StoredSuggestion> {
    const record: StoredSuggestion = {
      id: newId(),
      jobId: params.jobId,
      kind: params.kind,
      output: params.output,
      promptId: params.provenance.promptId,
      promptVersion: params.provenance.promptVersion,
      model: params.provenance.model,
      confidence: params.provenance.confidence,
      latencyMs: params.provenance.latencyMs,
      fellBackToRules: params.provenance.fellBackToRules,
      createdAt: new Date()
    };
    this.suggestions.push(record);
    return { ...record };
  }

  async listSuggestions(jobId: string, scope: Scope): Promise<StoredSuggestion[]> {
    this.requireJob(jobId, scope);
    return this.suggestions.filter((row) => row.jobId === jobId).map((row) => ({ ...row }));
  }

  /* ---------------------------------------------------------- idempotency */

  async findIdempotencyRecord(
    organizationId: string,
    key: string
  ): Promise<StoredIdempotencyRecord | null> {
    const record = this.idempotency.get(`${organizationId}:${key}`);
    if (!record) return null;
    if (record.expiresAt.getTime() <= Date.now()) {
      this.idempotency.delete(`${organizationId}:${key}`);
      return null;
    }
    return record;
  }

  async saveIdempotencyRecord(record: StoredIdempotencyRecord): Promise<void> {
    this.idempotency.set(`${record.organizationId}:${record.key}`, record);
  }

  async close(): Promise<void> {
    // Nothing to release.
  }
}
