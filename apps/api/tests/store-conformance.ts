import { describe, expect, it } from "vitest";
import type { Actor, Store } from "../src/store/types.js";
import { orgScope, staffScope } from "../src/store/types.js";

/**
 * Behaviour every Store implementation must exhibit.
 *
 * The in-memory store and the Prisma store are interchangeable only if they
 * agree on tenant visibility, the state machine and the offer race. This
 * suite is the definition of "agree", and both run it.
 *
 * `store-memory.test.ts` runs it against MemoryStore on every `pnpm test`.
 * `store-prisma.test.ts` runs it against PostgreSQL when DATABASE_URL is set,
 * and skips otherwise.
 */

export interface ConformanceContext {
  /** A fresh, empty store plus the fixture ids it was seeded with. */
  create(): Promise<{
    store: Store;
    organizationA: string;
    organizationB: string;
    providerA: string;
    providerB: string;
    actor: Actor;
  }>;
}

const JOB_INPUT = {
  type: "FAILED_DELIVERY" as const,
  urgency: "SAME_DAY" as const,
  pickup: { line1: "Am Markt 1", postalCode: "28195", city: "Bremen", countryCode: "DE" as const },
  items: [{ name: "Sofa", quantity: 1, estimatedWeightKg: 85 }],
  stairs: 0,
  liftAvailable: false
};

export function runStoreConformance(name: string, context: ConformanceContext): void {
  describe(`${name}: tenant visibility`, () => {
    it("findJob returns null for another tenant, not the row", async () => {
      const { store, organizationA, organizationB, actor } = await context.create();
      const job = await store.createJob({ organizationId: organizationA, input: JOB_INPUT, actor });

      expect(await store.findJob(job.id, orgScope(organizationA))).not.toBeNull();
      expect(await store.findJob(job.id, orgScope(organizationB))).toBeNull();
      await store.close();
    });

    it("listJobs never crosses tenants", async () => {
      const { store, organizationA, organizationB, actor } = await context.create();
      await store.createJob({ organizationId: organizationA, input: JOB_INPUT, actor });
      await store.createJob({ organizationId: organizationB, input: JOB_INPUT, actor });

      const a = await store.listJobs({ scope: orgScope(organizationA), limit: 50 });
      expect(a.items).toHaveLength(1);
      expect(a.items[0]!.organizationId).toBe(organizationA);
      await store.close();
    });

    it("staff scope sees every tenant", async () => {
      const { store, organizationA, organizationB, actor } = await context.create();
      await store.createJob({ organizationId: organizationA, input: JOB_INPUT, actor });
      await store.createJob({ organizationId: organizationB, input: JOB_INPUT, actor });

      const all = await store.listJobs({ scope: staffScope(), limit: 50 });
      expect(all.items).toHaveLength(2);
      await store.close();
    });

    it("transitionJob refuses to touch another tenant's job", async () => {
      const { store, organizationA, organizationB, actor } = await context.create();
      const job = await store.createJob({ organizationId: organizationA, input: JOB_INPUT, actor });

      await expect(
        store.transitionJob({
          jobId: job.id,
          scope: orgScope(organizationB),
          to: "TRIAGED",
          actor,
          eventType: "TRIAGE_APPROVED"
        })
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await store.close();
    });
  });

  describe(`${name}: pagination`, () => {
    it("pages without repeating or dropping a row", async () => {
      const { store, organizationA, actor } = await context.create();
      for (let index = 0; index < 7; index++) {
        await store.createJob({
          organizationId: organizationA,
          input: { ...JOB_INPUT, customerReference: `REF-${index}` },
          actor
        });
      }

      const seen: string[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const page: { items: { id: string }[]; nextCursor: string | null } = await store.listJobs({
          scope: orgScope(organizationA),
          limit: 3,
          cursor
        });
        seen.push(...page.items.map((job) => job.id));
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }

      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
      await store.close();
    });
  });

  describe(`${name}: state machine`, () => {
    it("allows the documented path and refuses the rest", async () => {
      const { store, organizationA, actor } = await context.create();
      const job = await store.createJob({ organizationId: organizationA, input: JOB_INPUT, actor });
      const scope = orgScope(organizationA);

      await expect(
        store.transitionJob({ jobId: job.id, scope, to: "COMPLETED", actor, eventType: "X" })
      ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });

      const triaged = await store.transitionJob({
        jobId: job.id,
        scope,
        to: "TRIAGED",
        actor,
        eventType: "TRIAGE_APPROVED"
      });
      expect(triaged.status).toBe("TRIAGED");

      await expect(
        store.transitionJob({ jobId: job.id, scope, to: "DRAFT", actor, eventType: "X" })
      ).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION" });
      await store.close();
    });

    it("writes a job event for every transition", async () => {
      const { store, organizationA, actor } = await context.create();
      const scope = orgScope(organizationA);
      const job = await store.createJob({ organizationId: organizationA, input: JOB_INPUT, actor });
      await store.transitionJob({
        jobId: job.id,
        scope,
        to: "TRIAGED",
        actor,
        eventType: "TRIAGE_APPROVED"
      });

      const events = await store.listJobEvents(job.id, scope);
      expect(events.map((event) => event.type)).toEqual(["JOB_CREATED", "TRIAGE_APPROVED"]);
      expect(events.every((event) => event.actorId === actor.userId)).toBe(true);
      await store.close();
    });

    it("a failed transition writes no event", async () => {
      const { store, organizationA, actor } = await context.create();
      const scope = orgScope(organizationA);
      const job = await store.createJob({ organizationId: organizationA, input: JOB_INPUT, actor });

      await expect(
        store.transitionJob({ jobId: job.id, scope, to: "COMPLETED", actor, eventType: "BAD" })
      ).rejects.toThrow();

      const events = await store.listJobEvents(job.id, scope);
      expect(events.map((event) => event.type)).toEqual(["JOB_CREATED"]);
      await store.close();
    });
  });

  describe(`${name}: offer acceptance`, () => {
    async function readyToOffer(ctx: Awaited<ReturnType<ConformanceContext["create"]>>) {
      const scope = orgScope(ctx.organizationA);
      const job = await ctx.store.createJob({
        organizationId: ctx.organizationA,
        input: JOB_INPUT,
        actor: ctx.actor
      });
      await ctx.store.transitionJob({
        jobId: job.id,
        scope,
        to: "TRIAGED",
        actor: ctx.actor,
        eventType: "TRIAGE_APPROVED"
      });
      await ctx.store.transitionJob({
        jobId: job.id,
        scope,
        to: "QUOTED",
        actor: ctx.actor,
        eventType: "JOB_QUOTED"
      });
      return job;
    }

    it("produces exactly one winner when two providers accept at once", async () => {
      const ctx = await context.create();
      const job = await readyToOffer(ctx);

      const offers = await ctx.store.createOffers({
        jobId: job.id,
        providerIds: [ctx.providerA, ctx.providerB],
        payoutNetCents: 18_000,
        expiresAt: new Date(Date.now() + 600_000),
        actor: ctx.actor
      });
      expect(offers).toHaveLength(2);

      const now = new Date();
      const results = await Promise.allSettled([
        ctx.store.acceptOffer({
          offerId: offers[0]!.id,
          providerId: ctx.providerA,
          now,
          actor: ctx.actor
        }),
        ctx.store.acceptOffer({
          offerId: offers[1]!.id,
          providerId: ctx.providerB,
          now,
          actor: ctx.actor
        })
      ]);

      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const assignment = await ctx.store.findActiveAssignment(job.id);
      expect(assignment).not.toBeNull();

      const after = await ctx.store.listOffersForJob(job.id);
      expect(after.filter((offer) => offer.status === "ACCEPTED")).toHaveLength(1);
      expect(after.filter((offer) => offer.status === "PENDING")).toHaveLength(0);
      await ctx.store.close();
    });

    it("refuses an expired offer", async () => {
      const ctx = await context.create();
      const job = await readyToOffer(ctx);
      const [offer] = await ctx.store.createOffers({
        jobId: job.id,
        providerIds: [ctx.providerA],
        payoutNetCents: 1000,
        expiresAt: new Date(Date.now() - 1000),
        actor: ctx.actor
      });

      await expect(
        ctx.store.acceptOffer({
          offerId: offer!.id,
          providerId: ctx.providerA,
          now: new Date(),
          actor: ctx.actor
        })
      ).rejects.toMatchObject({ code: "OFFER_EXPIRED" });
      await ctx.store.close();
    });

    it("refuses acceptance by a provider the offer was not addressed to", async () => {
      const ctx = await context.create();
      const job = await readyToOffer(ctx);
      const [offer] = await ctx.store.createOffers({
        jobId: job.id,
        providerIds: [ctx.providerA],
        payoutNetCents: 1000,
        expiresAt: new Date(Date.now() + 600_000),
        actor: ctx.actor
      });

      await expect(
        ctx.store.acceptOffer({
          offerId: offer!.id,
          providerId: ctx.providerB,
          now: new Date(),
          actor: ctx.actor
        })
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await ctx.store.close();
    });

    it("fallback releases the assignment and returns the job to QUOTED", async () => {
      const ctx = await context.create();
      const job = await readyToOffer(ctx);
      const [offer] = await ctx.store.createOffers({
        jobId: job.id,
        providerIds: [ctx.providerA],
        payoutNetCents: 1000,
        expiresAt: new Date(Date.now() + 600_000),
        actor: ctx.actor
      });
      await ctx.store.acceptOffer({
        offerId: offer!.id,
        providerId: ctx.providerA,
        now: new Date(),
        actor: ctx.actor
      });

      const returned = await ctx.store.fallbackAssignment({
        jobId: job.id,
        reason: "Van broke down",
        actor: ctx.actor
      });
      expect(returned.status).toBe("QUOTED");
      expect(await ctx.store.findActiveAssignment(job.id)).toBeNull();
      await ctx.store.close();
    });

    it("expires pending offers idempotently", async () => {
      const ctx = await context.create();
      const job = await readyToOffer(ctx);
      await ctx.store.createOffers({
        jobId: job.id,
        providerIds: [ctx.providerA],
        payoutNetCents: 1000,
        expiresAt: new Date(Date.now() - 1000),
        actor: ctx.actor
      });

      const first = await ctx.store.expireOffers(new Date(), ctx.actor);
      expect(first.expired).toBe(1);
      // The sweep also names the jobs it uncovered, so the caller does not
      // have to re-derive them with a query that races the next sweep.
      expect(first.jobIds).toHaveLength(1);

      const second = await ctx.store.expireOffers(new Date(), ctx.actor);
      expect(second.expired).toBe(0);
      expect(second.jobIds).toEqual([]);
      await ctx.store.close();
    });
  });

  describe(`${name}: idempotency records`, () => {
    it("are scoped per organisation", async () => {
      const { store, organizationA, organizationB } = await context.create();
      const base = {
        key: "same-key",
        method: "POST",
        path: "/v1/jobs",
        requestHash: "hash-a",
        statusCode: 201,
        responseBody: { data: "A" },
        expiresAt: new Date(Date.now() + 3_600_000)
      };
      await store.saveIdempotencyRecord({ ...base, organizationId: organizationA });
      await store.saveIdempotencyRecord({
        ...base,
        organizationId: organizationB,
        requestHash: "hash-b",
        responseBody: { data: "B" }
      });

      const a = await store.findIdempotencyRecord(organizationA, "same-key");
      const b = await store.findIdempotencyRecord(organizationB, "same-key");
      expect(a?.responseBody).toEqual({ data: "A" });
      expect(b?.responseBody).toEqual({ data: "B" });
      await store.close();
    });

    it("are not returned once expired", async () => {
      const { store, organizationA } = await context.create();
      await store.saveIdempotencyRecord({
        key: "old",
        organizationId: organizationA,
        method: "POST",
        path: "/v1/jobs",
        requestHash: "h",
        statusCode: 201,
        responseBody: {},
        expiresAt: new Date(Date.now() - 1000)
      });
      expect(await store.findIdempotencyRecord(organizationA, "old")).toBeNull();
      await store.close();
    });
  });

  describe(`${name}: provider availability`, () => {
    it("pausing records the note and resuming clears it", async () => {
      const { store, providerA, actor } = await context.create();

      const paused = await store.setProviderAvailability({
        providerId: providerA,
        acceptingWork: false,
        note: "Transporter in der Werkstatt",
        actor
      });
      expect(paused.acceptingWork).toBe(false);
      expect(paused.availabilityNote).toBe("Transporter in der Werkstatt");

      // A stale reason must not linger beside a provider taking work again.
      const resumed = await store.setProviderAvailability({
        providerId: providerA,
        acceptingWork: true,
        note: "ignored",
        actor
      });
      expect(resumed.acceptingWork).toBe(true);
      expect(resumed.availabilityNote).toBeNull();

      await store.close();
    });

    it("a provider starts out accepting work", async () => {
      const { store, providerA } = await context.create();
      const provider = await store.findProvider(providerA);
      expect(provider?.acceptingWork).toBe(true);
      expect(provider?.availabilityNote).toBeNull();
      await store.close();
    });

    it("availability does not touch the vetting status", async () => {
      const { store, providerA, actor } = await context.create();
      const before = await store.findProvider(providerA);
      await store.setProviderAvailability({
        providerId: providerA,
        acceptingWork: false,
        note: null,
        actor
      });
      const after = await store.findProvider(providerA);
      expect(after?.status).toBe(before?.status);
      await store.close();
    });
  });

  describe(`${name}: outbox statistics`, () => {
    it("counts an empty queue as zero in every status, not as an absence", async () => {
      const { store } = await context.create();
      const stats = await store.outboxStats();
      expect(stats.byStatus).toEqual({ PENDING: 0, SENT: 0, FAILED: 0, DEAD: 0 });
      expect(stats.oldestUndelivered).toBeNull();
      await store.close();
    });

    it("moves a row from PENDING to SENT as it is delivered", async () => {
      const { store, organizationA, actor } = await context.create();
      await store.createJob({ organizationId: organizationA, input: JOB_INPUT, actor });

      const before = await store.outboxStats();
      expect(before.byStatus.PENDING).toBeGreaterThan(0);
      expect(before.oldestUndelivered).toBeInstanceOf(Date);

      const claimed = await store.claimOutbox({ now: new Date(), limit: 50 });
      for (const message of claimed) {
        await store.markOutboxDelivered({ id: message.id, now: new Date() });
      }

      const after = await store.outboxStats();
      expect(after.byStatus.PENDING).toBe(0);
      expect(after.byStatus.SENT).toBe(before.byStatus.PENDING);
      expect(after.oldestUndelivered).toBeNull();
      await store.close();
    });

    it("counts a dead letter as still undelivered", async () => {
      const { store, organizationA, actor } = await context.create();
      await store.createJob({ organizationId: organizationA, input: JOB_INPUT, actor });
      const [message] = await store.claimOutbox({ now: new Date(), limit: 1 });

      // retryAt null means we have stopped trying.
      await store.markOutboxFailed({
        id: message!.id,
        error: "provider refused",
        now: new Date(),
        retryAt: null
      });

      const stats = await store.outboxStats();
      expect(stats.byStatus.DEAD).toBe(1);
      // The point of the assertion: a dead letter must not make the age
      // metric look healthy. It is the oldest thing that never happened.
      expect(stats.oldestUndelivered).toBeInstanceOf(Date);
      await store.close();
    });
  });
}
