import { canTransition, type CreateJobInput, type Job, type JobStatus } from "@rescue/contracts";
import type { Prisma, PrismaClient } from "@rescue/database";
import { AppError, conflict, invalidTransition, notFound } from "../lib/errors.js";
import { outboxForEvent } from "../lib/outbox.js";
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
 * PostgreSQL Store, via Prisma.
 *
 * Two things this implementation must get right that the in-memory one gets
 * for free:
 *
 * 1. Atomicity. Every state change writes its JobEvent and AuditLog inside the
 *    same `$transaction` as the mutation, so an audit record cannot be lost
 *    when the write after it fails (finding H5).
 * 2. Concurrency. Offer acceptance runs Serializable and relies on the partial
 *    unique index `Assignment_one_active_per_job` as the final arbiter, so two
 *    providers accepting at the same instant produce exactly one assignment
 *    even across processes.
 *
 * Both implementations are held to the same behaviour by the shared
 * conformance suite in tests/store-conformance.ts.
 */

/** Prisma's unique-constraint violation. */
const UNIQUE_VIOLATION = "P2002";

function isUniqueViolation(error: unknown): boolean {
  return (error as { code?: string })?.code === UNIQUE_VIOLATION;
}

type JobRow = Prisma.JobGetPayload<object>;

function toJob(row: JobRow): Job {
  return {
    id: row.id,
    organizationId: row.organizationId,
    status: row.status as JobStatus,
    type: row.type as Job["type"],
    urgency: row.urgency as Job["urgency"],
    pickup: row.pickup as unknown as Job["pickup"],
    destination: (row.destination as unknown as Job["destination"]) ?? undefined,
    items: row.items as unknown as Job["items"],
    stairs: row.stairs,
    liftAvailable: row.liftAvailable,
    requestedAt: row.requestedAt?.toISOString(),
    customerReference: row.customerReference ?? undefined,
    notes: row.notes ?? undefined,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

/** Translates a Scope into a Prisma `where` fragment. */
function scopeWhere(scope: Scope): Prisma.JobWhereInput {
  if (scope.kind === "staff") return {};
  if (scope.kind === "organization") return { organizationId: scope.organizationId };
  // A provider sees a job once it holds an assignment on it.
  return { assignments: { some: { providerId: scope.providerId } } };
}

/** Quotes are keyed by organisation, so they need their own translation. */
function quoteScopeWhere(scope: Scope): Prisma.QuoteWhereInput {
  if (scope.kind === "staff") return {};
  if (scope.kind === "organization") return { organizationId: scope.organizationId };
  // Providers never see customer pricing.
  return { id: "__never__" };
}

/** The client inside a `$transaction` callback: everything but the nested tx. */
type Tx = Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends">;

export class PrismaStore implements Store {
  constructor(private readonly db: PrismaClient) {}

  /**
   * Writes a job event and, in the SAME transaction, the outbox row it
   * implies.
   *
   * Every transition goes through here rather than touching `jobEvent`
   * directly, which is what makes "the job moved" and "somebody will be told"
   * a single atomic fact. `skipDuplicates` leans on the unique dedupe key: a
   * retried transaction re-enqueues the same intent and gets one row.
   */
  private async writeEvent(
    tx: Tx,
    jobId: string,
    actor: Actor,
    type: string,
    payload: Record<string, unknown> = {}
  ): Promise<void> {
    await tx.jobEvent.create({ data: this.eventData(jobId, actor, type, payload) });
    const draft = outboxForEvent({ jobId, type, payload });
    if (!draft) return;
    await tx.outboxMessage.createMany({
      data: [
        {
          topic: draft.topic,
          dedupeKey: draft.dedupeKey,
          jobId: draft.jobId,
          payload: draft.payload as Prisma.InputJsonValue
        }
      ],
      skipDuplicates: true
    });
  }

  /* ---------------------------------------------------------------- utils */

  private auditData(
    actor: Actor,
    action: string,
    entityType: string,
    entityId: string,
    metadata: Record<string, unknown> = {}
  ): Prisma.AuditLogCreateInput {
    return {
      actorId: actor.userId,
      actorRole: actor.role,
      action,
      entityType,
      entityId,
      metadata: metadata as Prisma.InputJsonValue,
      correlationId: actor.correlationId ?? null
    };
  }

  private eventData(
    jobId: string,
    actor: Actor,
    type: string,
    payload: Record<string, unknown> = {}
  ): Prisma.JobEventUncheckedCreateInput {
    return {
      jobId,
      actorId: actor.userId,
      type,
      payload: payload as Prisma.InputJsonValue,
      correlationId: actor.correlationId ?? null
    };
  }

  /* ------------------------------------------------------------- identity */

  async findUserBySubject(subject: string): Promise<StoredUser | null> {
    const user = await this.db.user.findUnique({
      where: { subject },
      include: { memberships: true }
    });
    if (!user) return null;
    return {
      id: user.id,
      subject: user.subject,
      email: user.email,
      name: user.name,
      memberships: user.memberships.map((membership) => ({
        id: membership.id,
        role: membership.role,
        organizationId: membership.organizationId,
        providerId: membership.providerId
      }))
    };
  }

  /* ----------------------------------------------------------------- jobs */

  async createJob(params: {
    organizationId: string;
    input: CreateJobInput;
    actor: Actor;
  }): Promise<Job> {
    return this.db.$transaction(async (tx) => {
      const job = await tx.job.create({
        data: {
          organizationId: params.organizationId,
          type: params.input.type,
          urgency: params.input.urgency,
          pickup: params.input.pickup as unknown as Prisma.InputJsonValue,
          destination: (params.input.destination ?? undefined) as unknown as Prisma.InputJsonValue,
          items: params.input.items as unknown as Prisma.InputJsonValue,
          stairs: params.input.stairs,
          liftAvailable: params.input.liftAvailable,
          requestedAt: params.input.requestedAt ? new Date(params.input.requestedAt) : null,
          customerReference: params.input.customerReference ?? null,
          notes: params.input.notes ?? null
        }
      });
      await this.writeEvent(tx, job.id, params.actor, "JOB_CREATED", { type: params.input.type });
      await tx.auditLog.create({
        data: this.auditData(params.actor, "JOB_CREATED", "Job", job.id, {
          organizationId: params.organizationId
        })
      });
      return toJob(job);
    });
  }

  async findJob(id: string, scope: Scope): Promise<Job | null> {
    // The tenant predicate is part of the query, not a check afterwards, so a
    // row from another tenant is never loaded into memory at all.
    const job = await this.db.job.findFirst({ where: { id, ...scopeWhere(scope) } });
    return job ? toJob(job) : null;
  }

  async listJobs(params: {
    scope: Scope;
    status?: JobStatus;
    limit: number;
    cursor?: string;
  }): Promise<Page<Job>> {
    const rows = await this.db.job.findMany({
      where: {
        ...scopeWhere(params.scope),
        ...(params.status ? { status: params.status } : {})
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: params.limit + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {})
    });
    const hasMore = rows.length > params.limit;
    const page = hasMore ? rows.slice(0, params.limit) : rows;
    return {
      items: page.map(toJob),
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null
    };
  }

  async transitionJob(input: TransitionInput): Promise<Job> {
    return this.db.$transaction(
      async (tx) => {
        const job = await tx.job.findFirst({ where: { id: input.jobId, ...scopeWhere(input.scope) } });
        if (!job) throw notFound("Job");
        if (!canTransition(job.status as JobStatus, input.to)) {
          throw invalidTransition(job.status, input.to);
        }

        const updated = await tx.job.update({
          where: { id: job.id },
          data: {
            status: input.to,
            ...(input.approved
              ? {
                  approvedVehicleClass: input.approved.vehicleClass,
                  approvedWorkers: input.approved.workers,
                  approvedCircularRoute: input.approved.circularRoute
                }
              : {})
          }
        });

        const payload = { from: job.status, to: input.to, ...input.payload };
        await this.writeEvent(tx, job.id, input.actor, input.eventType, payload);
        await tx.auditLog.create({
          data: this.auditData(input.actor, input.eventType, "Job", job.id, payload)
        });
        return toJob(updated);
      },
      { isolationLevel: "Serializable" }
    );
  }

  async listJobEvents(jobId: string, scope: Scope): Promise<StoredJobEvent[]> {
    const job = await this.db.job.findFirst({ where: { id: jobId, ...scopeWhere(scope) } });
    if (!job) throw notFound("Job");
    const events = await this.db.jobEvent.findMany({
      where: { jobId },
      orderBy: { createdAt: "asc" }
    });
    return events.map((event) => ({
      id: event.id,
      jobId: event.jobId,
      actorId: event.actorId,
      type: event.type,
      payload: (event.payload ?? {}) as Record<string, unknown>,
      correlationId: event.correlationId,
      createdAt: event.createdAt
    }));
  }

  /* ------------------------------------------------------------ providers */

  async createProvider(params: {
    input: Parameters<Store["createProvider"]>[0]["input"];
    actor: Actor;
    ownerUserId: string;
  }): Promise<StoredProvider> {
    return this.db.$transaction(async (tx) => {
      const provider = await tx.provider.create({
        data: {
          legalName: params.input.legalName,
          basePostalCode: params.input.basePostalCode,
          serviceRadiusKm: params.input.serviceRadiusKm,
          serviceTypes: params.input.serviceTypes,
          contactEmail: params.input.contactEmail,
          vatId: params.input.vatId ?? null
        }
      });
      await tx.auditLog.create({
        data: this.auditData(params.actor, "PROVIDER_CREATED", "Provider", provider.id, {
          legalName: provider.legalName
        })
      });
      return { ...provider, serviceTypes: provider.serviceTypes as string[] };
    });
  }

  async findProvider(id: string): Promise<StoredProvider | null> {
    const provider = await this.db.provider.findUnique({ where: { id } });
    return provider ? { ...provider, serviceTypes: provider.serviceTypes as string[] } : null;
  }

  async listProviders(params: { status?: StoredProvider["status"] }): Promise<StoredProvider[]> {
    const providers = await this.db.provider.findMany({
      where: params.status ? { status: params.status } : {},
      orderBy: { id: "asc" }
    });
    return providers.map((provider) => ({
      ...provider,
      serviceTypes: provider.serviceTypes as string[]
    }));
  }

  async setProviderStatus(params: {
    providerId: string;
    status: StoredProvider["status"];
    reason: string;
    actor: Actor;
  }): Promise<StoredProvider> {
    return this.db.$transaction(async (tx) => {
      const existing = await tx.provider.findUnique({ where: { id: params.providerId } });
      if (!existing) throw notFound("Provider");
      const provider = await tx.provider.update({
        where: { id: params.providerId },
        data: { status: params.status }
      });
      await tx.auditLog.create({
        data: this.auditData(params.actor, "PROVIDER_STATUS_CHANGED", "Provider", provider.id, {
          from: existing.status,
          to: params.status,
          reason: params.reason
        })
      });
      return { ...provider, serviceTypes: provider.serviceTypes as string[] };
    });
  }

  async setProviderAvailability(params: {
    providerId: string;
    acceptingWork: boolean;
    note: string | null;
    actor: Actor;
  }): Promise<StoredProvider> {
    return this.db.$transaction(async (tx) => {
      const existing = await tx.provider.findUnique({ where: { id: params.providerId } });
      if (!existing) throw notFound("Provider");
      // Resuming clears the note, matching the CHECK constraint the migration
      // adds: a note may only exist while the provider is paused.
      const availabilityNote = params.acceptingWork ? null : params.note;
      const provider = await tx.provider.update({
        where: { id: params.providerId },
        data: { acceptingWork: params.acceptingWork, availabilityNote }
      });
      await tx.auditLog.create({
        data: this.auditData(
          params.actor,
          "PROVIDER_AVAILABILITY_CHANGED",
          "Provider",
          provider.id,
          { from: existing.acceptingWork, to: params.acceptingWork, note: availabilityNote }
        )
      });
      return { ...provider, serviceTypes: provider.serviceTypes as string[] };
    });
  }

  async createVehicle(params: {
    providerId: string;
    input: Parameters<Store["createVehicle"]>[0]["input"];
    registrationHash: string;
    actor: Actor;
  }): Promise<StoredVehicle> {
    const provider = await this.db.provider.findUnique({ where: { id: params.providerId } });
    if (!provider) throw notFound("Provider");
    try {
      return await this.db.$transaction(async (tx) => {
        const vehicle = await tx.vehicle.create({
          data: {
            providerId: params.providerId,
            registrationHash: params.registrationHash,
            vehicleClass: params.input.vehicleClass,
            payloadKg: params.input.payloadKg,
            volumeM3: params.input.volumeM3,
            active: params.input.active
          }
        });
        await tx.auditLog.create({
          data: this.auditData(params.actor, "VEHICLE_ADDED", "Vehicle", vehicle.id, {
            providerId: params.providerId
          })
        });
        return { ...vehicle, volumeM3: Number(vehicle.volumeM3) };
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict("This vehicle is already registered to the provider");
      }
      throw error;
    }
  }

  async listVehicles(providerId: string): Promise<StoredVehicle[]> {
    const vehicles = await this.db.vehicle.findMany({ where: { providerId } });
    return vehicles.map((vehicle) => ({ ...vehicle, volumeM3: Number(vehicle.volumeM3) }));
  }

  async createDocument(params: {
    providerId: string;
    input: Parameters<Store["createDocument"]>[0]["input"];
    actor: Actor;
  }): Promise<StoredDocument> {
    const provider = await this.db.provider.findUnique({ where: { id: params.providerId } });
    if (!provider) throw notFound("Provider");
    return this.db.$transaction(async (tx) => {
      const document = await tx.providerDocument.create({
        data: {
          providerId: params.providerId,
          type: params.input.type,
          storageKey: params.input.storageKey,
          expiresAt: params.input.expiresAt ? new Date(params.input.expiresAt) : null
        }
      });
      await tx.auditLog.create({
        data: this.auditData(params.actor, "DOCUMENT_SUBMITTED", "ProviderDocument", document.id, {
          providerId: params.providerId,
          type: document.type
        })
      });
      return document;
    });
  }

  async listDocuments(providerId: string): Promise<StoredDocument[]> {
    return this.db.providerDocument.findMany({ where: { providerId } });
  }

  async reviewDocument(params: {
    documentId: string;
    status: "VERIFIED" | "REJECTED";
    reason: string;
    actor: Actor;
  }): Promise<StoredDocument> {
    return this.db.$transaction(async (tx) => {
      const existing = await tx.providerDocument.findUnique({ where: { id: params.documentId } });
      if (!existing) throw notFound("Document");
      const document = await tx.providerDocument.update({
        where: { id: params.documentId },
        data: { status: params.status, reviewedAt: new Date() }
      });
      await tx.auditLog.create({
        data: this.auditData(params.actor, "DOCUMENT_REVIEWED", "ProviderDocument", document.id, {
          status: params.status,
          reason: params.reason
        })
      });
      return document;
    });
  }

  /* --------------------------------------------------------------- quotes */

  async createQuote(params: Parameters<Store["createQuote"]>[0]): Promise<StoredQuote> {
    return this.db.$transaction(async (tx) => {
      const quote = await tx.quote.create({
        data: {
          jobId: params.jobId,
          organizationId: params.organizationId,
          netCents: params.netCents,
          vatCents: params.vatCents,
          grossCents: params.grossCents,
          vatRateBasisPoints: params.vatRateBasisPoints,
          breakdown: (params.breakdown ?? undefined) as unknown as Prisma.InputJsonValue,
          notes: params.notes,
          validUntil: params.validUntil
        }
      });
      await this.writeEvent(tx, params.jobId, params.actor, "QUOTE_SENT", {
          quoteId: quote.id,
          grossCents: quote.grossCents
        });
      await tx.auditLog.create({
        data: this.auditData(params.actor, "QUOTE_SENT", "Quote", quote.id, {
          jobId: params.jobId,
          grossCents: quote.grossCents
        })
      });
      return this.toQuote(quote);
    });
  }

  private toQuote(row: Prisma.QuoteGetPayload<object>): StoredQuote {
    return {
      id: row.id,
      jobId: row.jobId,
      organizationId: row.organizationId,
      status: row.status,
      netCents: row.netCents,
      vatCents: row.vatCents,
      grossCents: row.grossCents,
      vatRateBasisPoints: row.vatRateBasisPoints,
      currency: "EUR",
      breakdown: (row.breakdown as unknown as StoredQuote["breakdown"]) ?? null,
      notes: row.notes,
      validUntil: row.validUntil,
      approvedAt: row.approvedAt,
      approvedByUserId: row.approvedByUserId,
      createdAt: row.createdAt
    };
  }

  async findQuote(id: string, scope: Scope): Promise<StoredQuote | null> {
    const quote = await this.db.quote.findFirst({ where: { id, ...quoteScopeWhere(scope) } });
    return quote ? this.toQuote(quote) : null;
  }

  async listQuotesForJob(jobId: string, scope: Scope): Promise<StoredQuote[]> {
    const job = await this.db.job.findFirst({ where: { id: jobId, ...scopeWhere(scope) } });
    if (!job) throw notFound("Job");
    // Pricing is between RESCUE and the customer; providers see their payout.
    if (scope.kind === "provider") return [];
    const quotes = await this.db.quote.findMany({ where: { jobId }, orderBy: { createdAt: "asc" } });
    return quotes.map((quote) => this.toQuote(quote));
  }

  async decideQuote(params: {
    quoteId: string;
    scope: Scope;
    decision: "APPROVE" | "REJECT";
    reason?: string;
    actor: Actor;
  }): Promise<{ quote: StoredQuote; job: Job }> {
    return this.db.$transaction(
      async (tx) => {
        const existing = await tx.quote.findFirst({
          where: { id: params.quoteId, ...quoteScopeWhere(params.scope) }
        });
        if (!existing) throw notFound("Quote");
        if (existing.status !== "SENT") {
          throw conflict(`This quote is ${existing.status.toLowerCase()} and can no longer be decided`);
        }
        if (existing.validUntil.getTime() <= Date.now()) {
          await tx.quote.update({ where: { id: existing.id }, data: { status: "EXPIRED" } });
          throw conflict("This quote has expired");
        }

        const status = params.decision === "APPROVE" ? "APPROVED" : "REJECTED";
        const quote = await tx.quote.update({
          where: { id: existing.id },
          data: {
            status,
            ...(params.decision === "APPROVE"
              ? { approvedAt: new Date(), approvedByUserId: params.actor.userId }
              : {})
          }
        });

        const job = await tx.job.findFirst({
          where: { id: quote.jobId, ...scopeWhere(params.scope) }
        });
        if (!job) throw notFound("Job");

        await this.writeEvent(tx, quote.jobId, params.actor, `QUOTE_${status}`, {
            quoteId: quote.id,
            reason: params.reason
          });
        await tx.auditLog.create({
          data: this.auditData(params.actor, `QUOTE_${status}`, "Quote", quote.id, {
            jobId: quote.jobId,
            reason: params.reason
          })
        });
        return { quote: this.toQuote(quote), job: toJob(job) };
      },
      { isolationLevel: "Serializable" }
    );
  }

  /* ---------------------------------------------------------- assignments */

  async createOffers(params: {
    jobId: string;
    providerIds: string[];
    payoutNetCents: number;
    expiresAt: Date;
    actor: Actor;
  }): Promise<StoredOffer[]> {
    return this.db.$transaction(async (tx) => {
      const created: StoredOffer[] = [];
      for (const providerId of params.providerIds) {
        // One live offer per (job, provider); a repeat round skips rather than
        // failing the whole fan-out.
        const existing = await tx.assignmentOffer.findUnique({
          where: { jobId_providerId: { jobId: params.jobId, providerId } }
        });
        if (existing) continue;
        created.push(
          this.toOffer(
            await tx.assignmentOffer.create({
              data: {
                jobId: params.jobId,
                providerId,
                payoutNetCents: params.payoutNetCents,
                expiresAt: params.expiresAt
              }
            })
          )
        );
      }
      await this.writeEvent(tx, params.jobId, params.actor, "OFFERS_SENT", {
          providerCount: created.length,
          payoutNetCents: params.payoutNetCents
        });
      await tx.auditLog.create({
        data: this.auditData(params.actor, "OFFERS_SENT", "Job", params.jobId, {
          providerIds: created.map((offer) => offer.providerId)
        })
      });
      return created;
    });
  }

  private toOffer(row: Prisma.AssignmentOfferGetPayload<object>): StoredOffer {
    return {
      id: row.id,
      jobId: row.jobId,
      providerId: row.providerId,
      status: row.status,
      payoutNetCents: row.payoutNetCents,
      currency: "EUR",
      expiresAt: row.expiresAt,
      respondedAt: row.respondedAt,
      declineReason: row.declineReason,
      createdAt: row.createdAt
    };
  }

  private toAssignment(row: Prisma.AssignmentGetPayload<object>): StoredAssignment {
    return {
      id: row.id,
      jobId: row.jobId,
      providerId: row.providerId,
      status: row.status,
      payoutNetCents: row.payoutNetCents,
      currency: "EUR",
      acceptedAt: row.acceptedAt,
      completedAt: row.completedAt
    };
  }

  async listOffersForJob(jobId: string): Promise<StoredOffer[]> {
    return (await this.db.assignmentOffer.findMany({ where: { jobId } })).map((offer) =>
      this.toOffer(offer)
    );
  }

  async listOffersForProvider(params: {
    providerId: string;
    status?: StoredOffer["status"];
  }): Promise<StoredOffer[]> {
    const offers = await this.db.assignmentOffer.findMany({
      where: { providerId: params.providerId, ...(params.status ? { status: params.status } : {}) }
    });
    return offers.map((offer) => this.toOffer(offer));
  }

  async findOffer(id: string): Promise<StoredOffer | null> {
    const offer = await this.db.assignmentOffer.findUnique({ where: { id } });
    return offer ? this.toOffer(offer) : null;
  }

  async acceptOffer(params: {
    offerId: string;
    providerId: string;
    now: Date;
    actor: Actor;
  }): Promise<AcceptOfferResult> {
    try {
      return await this.db.$transaction(
        async (tx) => {
          const offer = await tx.assignmentOffer.findUnique({ where: { id: params.offerId } });
          if (!offer || offer.providerId !== params.providerId) throw notFound("Offer");

          if (offer.status === "EXPIRED" || offer.expiresAt.getTime() <= params.now.getTime()) {
            await tx.assignmentOffer.update({
              where: { id: offer.id },
              data: { status: "EXPIRED", respondedAt: params.now }
            });
            throw new AppError(409, "OFFER_EXPIRED", "This offer has expired");
          }
          if (offer.status !== "PENDING") {
            throw new AppError(409, "OFFER_ALREADY_TAKEN", "This offer is no longer open");
          }

          const job = await tx.job.findUnique({ where: { id: offer.jobId } });
          if (!job) throw notFound("Job");
          if (!canTransition(job.status as JobStatus, "ASSIGNED")) {
            throw invalidTransition(job.status, "ASSIGNED");
          }

          // The partial unique index on (jobId) WHERE status = 'ACTIVE' is the
          // real guarantee. This read is an early exit, not the lock.
          const taken = await tx.assignment.findFirst({
            where: { jobId: offer.jobId, status: "ACTIVE" }
          });
          if (taken) {
            throw new AppError(
              409,
              "OFFER_ALREADY_TAKEN",
              "Another provider has already accepted this job"
            );
          }

          const assignment = await tx.assignment.create({
            data: {
              jobId: offer.jobId,
              providerId: offer.providerId,
              payoutNetCents: offer.payoutNetCents,
              acceptedAt: params.now
            }
          });

          const accepted = await tx.assignmentOffer.update({
            where: { id: offer.id },
            data: { status: "ACCEPTED", respondedAt: params.now }
          });

          await tx.assignmentOffer.updateMany({
            where: { jobId: offer.jobId, status: "PENDING", id: { not: offer.id } },
            data: { status: "WITHDRAWN", respondedAt: params.now }
          });

          const updatedJob = await tx.job.update({
            where: { id: job.id },
            data: { status: "ASSIGNED" }
          });

          const payload = {
            from: job.status,
            to: "ASSIGNED",
            offerId: offer.id,
            providerId: offer.providerId
          };
          await this.writeEvent(tx, job.id, params.actor, "OFFER_ACCEPTED", payload);
          await tx.auditLog.create({
            data: this.auditData(params.actor, "OFFER_ACCEPTED", "Assignment", assignment.id, {
              jobId: job.id,
              providerId: offer.providerId,
              payoutNetCents: offer.payoutNetCents
            })
          });

          return {
            offer: this.toOffer(accepted),
            assignment: this.toAssignment(assignment),
            job: toJob(updatedJob)
          };
        },
        { isolationLevel: "Serializable" }
      );
    } catch (error) {
      // Lost the race at the database level: another transaction inserted the
      // ACTIVE assignment first. Report it the same way as the early exit.
      if (isUniqueViolation(error)) {
        throw new AppError(409, "OFFER_ALREADY_TAKEN", "Another provider has already accepted this job");
      }
      throw error;
    }
  }

  async declineOffer(params: {
    offerId: string;
    providerId: string;
    reason?: string;
    actor: Actor;
  }): Promise<StoredOffer> {
    return this.db.$transaction(async (tx) => {
      const offer = await tx.assignmentOffer.findUnique({ where: { id: params.offerId } });
      if (!offer || offer.providerId !== params.providerId) throw notFound("Offer");
      if (offer.status !== "PENDING") throw conflict("This offer is no longer open");

      const declined = await tx.assignmentOffer.update({
        where: { id: offer.id },
        data: { status: "DECLINED", respondedAt: new Date(), declineReason: params.reason ?? null }
      });
      await this.writeEvent(tx, offer.jobId, params.actor, "OFFER_DECLINED", {
          offerId: offer.id,
          providerId: offer.providerId
        });
      await tx.auditLog.create({
        data: this.auditData(params.actor, "OFFER_DECLINED", "AssignmentOffer", offer.id, {
          jobId: offer.jobId,
          reason: params.reason
        })
      });
      return this.toOffer(declined);
    });
  }

  async expireOffers(now: Date, actor: Actor): Promise<{ expired: number; jobIds: string[] }> {
    return this.db.$transaction(async (tx) => {
      const due = await tx.assignmentOffer.findMany({
        where: { status: "PENDING", expiresAt: { lte: now } }
      });
      if (due.length === 0) return { expired: 0, jobIds: [] };

      await tx.assignmentOffer.updateMany({
        where: { id: { in: due.map((offer) => offer.id) } },
        data: { status: "EXPIRED", respondedAt: now }
      });
      // One at a time rather than createMany, so each expiry also lands its
      // outbox row inside this transaction. A sweep of a few dozen offers is
      // not the hot path, and correctness is worth the round trips.
      for (const offer of due) {
        await this.writeEvent(tx, offer.jobId, actor, "OFFER_EXPIRED", { offerId: offer.id });
      }
      await tx.auditLog.create({
        data: this.auditData(actor, "OFFERS_EXPIRED", "AssignmentOffer", "sweep", { count: due.length })
      });
      return { expired: due.length, jobIds: [...new Set(due.map((offer) => offer.jobId))] };
    });
  }

  async findActiveAssignment(jobId: string): Promise<StoredAssignment | null> {
    const assignment = await this.db.assignment.findFirst({ where: { jobId, status: "ACTIVE" } });
    return assignment ? this.toAssignment(assignment) : null;
  }

  async fallbackAssignment(params: { jobId: string; reason: string; actor: Actor }): Promise<Job> {
    return this.db.$transaction(
      async (tx) => {
        const job = await tx.job.findUnique({ where: { id: params.jobId } });
        if (!job) throw notFound("Job");
        const assignment = await tx.assignment.findFirst({
          where: { jobId: params.jobId, status: "ACTIVE" }
        });
        if (!assignment) throw conflict("This job has no active assignment");
        // Back to QUOTED, not TRIAGED. See docs/adr/0001.
        if (!canTransition(job.status as JobStatus, "QUOTED")) {
          throw invalidTransition(job.status, "QUOTED");
        }

        await tx.assignment.update({
          where: { id: assignment.id },
          data: { status: "FELL_THROUGH", fellThroughAt: new Date() }
        });
        const updated = await tx.job.update({ where: { id: job.id }, data: { status: "QUOTED" } });

        const payload = {
          from: job.status,
          to: "QUOTED",
          providerId: assignment.providerId,
          reason: params.reason
        };
        await this.writeEvent(tx, job.id, params.actor, "ASSIGNMENT_FELL_THROUGH", payload);
        await tx.auditLog.create({
          data: this.auditData(params.actor, "ASSIGNMENT_FELL_THROUGH", "Assignment", assignment.id, {
            jobId: job.id,
            reason: params.reason
          })
        });
        return toJob(updated);
      },
      { isolationLevel: "Serializable" }
    );
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
    return this.db.$transaction(async (tx) => {
      const evidence = await tx.evidence.create({
        data: {
          jobId: params.jobId,
          kind: params.kind,
          mimeType: params.mimeType,
          sizeBytes: params.sizeBytes,
          storageKey: params.storageKey
        }
      });
      await tx.auditLog.create({
        data: this.auditData(params.actor, "EVIDENCE_REQUESTED", "Evidence", evidence.id, {
          jobId: params.jobId,
          kind: params.kind
        })
      });
      return evidence as StoredEvidence;
    });
  }

  async markEvidenceUploaded(params: { evidenceId: string; actor: Actor }): Promise<StoredEvidence> {
    return this.db.$transaction(async (tx) => {
      const existing = await tx.evidence.findUnique({ where: { id: params.evidenceId } });
      if (!existing) throw notFound("Evidence");
      const evidence = await tx.evidence.update({
        where: { id: params.evidenceId },
        data: {
          status: "UPLOADED",
          uploadedAt: new Date(),
          uploadedByUserId: params.actor.userId
        }
      });
      await this.writeEvent(tx, evidence.jobId, params.actor, "EVIDENCE_UPLOADED", {
          evidenceId: evidence.id,
          kind: evidence.kind
        });
      await tx.auditLog.create({
        data: this.auditData(params.actor, "EVIDENCE_UPLOADED", "Evidence", evidence.id, {
          jobId: evidence.jobId
        })
      });
      return evidence as StoredEvidence;
    });
  }

  async listEvidence(jobId: string, scope: Scope): Promise<StoredEvidence[]> {
    const job = await this.db.job.findFirst({ where: { id: jobId, ...scopeWhere(scope) } });
    if (!job) throw notFound("Job");
    return (await this.db.evidence.findMany({ where: { jobId } })) as StoredEvidence[];
  }

  async findEvidence(evidenceId: string, scope: Scope): Promise<StoredEvidence | null> {
    // The scope is applied to the parent job in the same query, so a row in
    // another tenant is simply not found.
    const evidence = await this.db.evidence.findFirst({
      where: { id: evidenceId, job: scopeWhere(scope) }
    });
    return (evidence as StoredEvidence | null) ?? null;
  }

  async recordJobEvent(params: {
    jobId: string;
    type: string;
    payload?: Record<string, unknown>;
    actor: Actor;
  }): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const job = await tx.job.findUnique({ where: { id: params.jobId } });
      if (!job) throw notFound("Job");
      await this.writeEvent(tx, params.jobId, params.actor, params.type, params.payload ?? {});
    });
  }

  /* --------------------------------------------------------------- outbox */

  async claimOutbox(params: { now: Date; limit: number }): Promise<StoredOutboxMessage[]> {
    // SKIP LOCKED is the point: two workers polling the same instant take
    // disjoint sets instead of one blocking on the other's rows. The lease is
    // the `availableAt` push, so a worker that dies mid-delivery releases its
    // messages by timeout rather than holding them forever.
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "OutboxMessage"
        WHERE "status" IN ('PENDING', 'FAILED') AND "availableAt" <= ${params.now}
        ORDER BY "createdAt" ASC
        LIMIT ${params.limit}
        FOR UPDATE SKIP LOCKED
      `;
      if (rows.length === 0) return [];
      const ids = rows.map((row) => row.id);
      const lease = new Date(params.now.getTime() + 60_000);
      await tx.outboxMessage.updateMany({ where: { id: { in: ids } }, data: { availableAt: lease } });
      const claimed = await tx.outboxMessage.findMany({
        where: { id: { in: ids } },
        orderBy: { createdAt: "asc" }
      });
      return claimed.map((row) => this.toOutbox(row));
    });
  }

  async markOutboxDelivered(params: { id: string; now: Date }): Promise<void> {
    await this.db.outboxMessage.update({
      where: { id: params.id },
      // Status and timestamp move together: the CHECK constraint refuses one
      // without the other, which is how "is this delivered" stays answerable
      // from a single row.
      data: { status: "SENT", deliveredAt: params.now, lastError: null }
    });
  }

  async markOutboxFailed(params: {
    id: string;
    error: string;
    now: Date;
    retryAt: Date | null;
  }): Promise<void> {
    await this.db.outboxMessage.update({
      where: { id: params.id },
      data: {
        attempts: { increment: 1 },
        lastError: params.error.slice(0, 500),
        status: params.retryAt ? "FAILED" : "DEAD",
        ...(params.retryAt ? { availableAt: params.retryAt } : {})
      }
    });
  }

  async listOutbox(params: {
    jobId?: string;
    status?: StoredOutboxMessage["status"];
  }): Promise<StoredOutboxMessage[]> {
    const rows = await this.db.outboxMessage.findMany({
      where: {
        ...(params.jobId ? { jobId: params.jobId } : {}),
        ...(params.status ? { status: params.status } : {})
      },
      orderBy: { createdAt: "asc" }
    });
    return rows.map((row) => this.toOutbox(row));
  }

  private toOutbox(row: {
    id: string;
    topic: string;
    dedupeKey: string;
    jobId: string | null;
    payload: unknown;
    status: string;
    attempts: number;
    availableAt: Date;
    lastError: string | null;
    createdAt: Date;
    deliveredAt: Date | null;
  }): StoredOutboxMessage {
    return {
      id: row.id,
      topic: row.topic as StoredOutboxMessage["topic"],
      dedupeKey: row.dedupeKey,
      jobId: row.jobId,
      payload: (row.payload ?? {}) as Record<string, unknown>,
      status: row.status as StoredOutboxMessage["status"],
      attempts: row.attempts,
      availableAt: row.availableAt,
      lastError: row.lastError,
      createdAt: row.createdAt,
      deliveredAt: row.deliveredAt
    };
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
    return this.db.$transaction(async (tx) => {
      const written: StoredLedgerEntry[] = [];
      for (const entry of params.entries) {
        const row = await tx.ledgerEntry.create({
          data: {
            jobId: entry.jobId,
            kind: entry.kind,
            amountCents: entry.amountCents,
            externalReference: entry.externalReference ?? null,
            note: entry.note ?? null
          }
        });
        await tx.auditLog.create({
          data: this.auditData(params.actor, "LEDGER_ENTRY_APPENDED", "LedgerEntry", row.id, {
            jobId: row.jobId,
            kind: row.kind,
            amountCents: row.amountCents
          })
        });
        written.push(row as StoredLedgerEntry);
      }
      return written;
    });
  }

  async listLedger(jobId: string, scope: Scope): Promise<StoredLedgerEntry[]> {
    const job = await this.db.job.findFirst({ where: { id: jobId, ...scopeWhere(scope) } });
    if (!job) throw notFound("Job");
    return (await this.db.ledgerEntry.findMany({
      where: { jobId },
      orderBy: { createdAt: "asc" }
    })) as StoredLedgerEntry[];
  }

  /* ---------------------------------------------------------- suggestions */

  async recordSuggestion(params: {
    jobId: string;
    kind: string;
    output: unknown;
    provenance: Parameters<Store["recordSuggestion"]>[0]["provenance"];
  }): Promise<StoredSuggestion> {
    const row = await this.db.suggestion.create({
      data: {
        jobId: params.jobId,
        kind: params.kind,
        output: params.output as Prisma.InputJsonValue,
        promptId: params.provenance.promptId,
        promptVersion: params.provenance.promptVersion,
        model: params.provenance.model,
        confidence: params.provenance.confidence,
        latencyMs: params.provenance.latencyMs,
        fellBackToRules: params.provenance.fellBackToRules
      }
    });
    return row as StoredSuggestion;
  }

  async listSuggestions(jobId: string, scope: Scope): Promise<StoredSuggestion[]> {
    const job = await this.db.job.findFirst({ where: { id: jobId, ...scopeWhere(scope) } });
    if (!job) throw notFound("Job");
    return (await this.db.suggestion.findMany({
      where: { jobId },
      orderBy: { createdAt: "asc" }
    })) as StoredSuggestion[];
  }

  /* ---------------------------------------------------------- idempotency */

  async findIdempotencyRecord(
    organizationId: string,
    key: string
  ): Promise<StoredIdempotencyRecord | null> {
    const record = await this.db.idempotencyKey.findUnique({
      where: { organizationId_key: { organizationId, key } }
    });
    if (!record) return null;
    if (record.expiresAt.getTime() <= Date.now()) return null;
    return {
      key: record.key,
      organizationId: record.organizationId,
      method: record.method,
      path: record.path,
      requestHash: record.requestHash,
      statusCode: record.statusCode,
      responseBody: record.responseBody,
      expiresAt: record.expiresAt
    };
  }

  async saveIdempotencyRecord(record: StoredIdempotencyRecord): Promise<void> {
    await this.db.idempotencyKey.upsert({
      where: { organizationId_key: { organizationId: record.organizationId, key: record.key } },
      create: {
        organizationId: record.organizationId,
        key: record.key,
        method: record.method,
        path: record.path,
        requestHash: record.requestHash,
        statusCode: record.statusCode,
        responseBody: record.responseBody as Prisma.InputJsonValue,
        expiresAt: record.expiresAt
      },
      update: {
        requestHash: record.requestHash,
        statusCode: record.statusCode,
        responseBody: record.responseBody as Prisma.InputJsonValue,
        expiresAt: record.expiresAt
      }
    });
  }

  async close(): Promise<void> {
    await this.db.$disconnect();
  }
}
