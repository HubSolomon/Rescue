import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FixedClock } from "../src/lib/clock.js";
import { DATA_INVENTORY, REDACTED_NAME, classificationFor } from "../src/lib/privacy.js";
import { RetentionJob } from "../src/lib/retention.js";
import { MockEvidenceStorage } from "../src/lib/storage.js";
import { createMetrics } from "../src/lib/metrics.js";
import { MemoryStore } from "../src/store/memory.js";
import { developmentSeed } from "../src/seed.js";
import { harness, idem, SUBJECTS, VALID_JOB, type Harness } from "./helpers.js";

/**
 * Data protection.
 *
 * The parts of the GDPR a code base can actually be held to: know what you
 * store, delete it when its purpose ends, and be able to sever a person from
 * it on request without destroying the records you are required to keep.
 */

let open: Harness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

const SCHEMA = readFileSync(
  join(process.cwd(), "../../packages/database/prisma/schema.prisma"),
  "utf8"
);

function modelsInSchema(): string[] {
  return [...SCHEMA.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1]!);
}

describe("the inventory describes the schema that exists", () => {
  /**
   * The test that makes the inventory worth having.
   *
   * A record of processing activities is normally a document, and a document
   * drifts. This fails the build the day someone adds a table without saying
   * what is in it -- which is the only moment at which classifying it is cheap.
   */
  it("classifies every model in schema.prisma", () => {
    const unclassified = modelsInSchema().filter((model) => !classificationFor(model));
    expect(unclassified, `unclassified models: ${unclassified.join(", ")}`).toEqual([]);
  });

  it("does not classify a model that no longer exists", () => {
    const models = new Set(modelsInSchema());
    const stale = DATA_INVENTORY.filter((entry) => !models.has(entry.table)).map((e) => e.table);
    expect(stale, `classified but absent: ${stale.join(", ")}`).toEqual([]);
  });

  it("names every personal field on a model that actually has it", () => {
    for (const entry of DATA_INVENTORY) {
      const block = SCHEMA.match(new RegExp(`^model\\s+${entry.table}\\s*\\{([\\s\\S]*?)^\\}`, "m"));
      expect(block, `no block for ${entry.table}`).not.toBeNull();
      for (const field of entry.personalFields) {
        expect(block![1], `${entry.table}.${field}`).toMatch(new RegExp(`\\b${field}\\b`));
      }
    }
  });

  it("gives every classification a reason someone can read", () => {
    for (const entry of DATA_INVENTORY) {
      expect(entry.note.length, entry.table).toBeGreaterThan(40);
    }
  });

  it("keeps a retention period on everything it says is deletable", () => {
    for (const entry of DATA_INVENTORY) {
      if (entry.erasure !== "delete") continue;
      expect(entry.retentionDays, entry.table).not.toBeNull();
    }
  });
});

describe("the audit stream holds no personal data", () => {
  /**
   * The invariant the whole retention design rests on.
   *
   * JobEvent and AuditLog are append-only in PostgreSQL, by trigger. If either
   * ever carried an address, erasure would require modifying a table that
   * refuses modification -- so the property has to be maintained, not
   * discovered later.
   */
  it("no event payload contains an address, a name or a contact", async () => {
    open = await harness();
    const h = open;
    const customer = await h.auth(SUBJECTS.customerAdmin);

    const created = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...customer, ...idem() },
      payload: VALID_JOB
    });
    const jobId = created.json().data.job.id as string;

    const events = await h.store.listJobEvents(jobId, { kind: "staff" });
    expect(events.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(events);

    for (const secret of [
      VALID_JOB.pickup.line1,
      VALID_JOB.destination.line1,
      VALID_JOB.notes,
      VALID_JOB.customerReference
    ]) {
      expect(serialised, `event payload leaked "${secret}"`).not.toContain(secret);
    }
  });

  it("the classification says so too, so the two cannot drift apart", () => {
    expect(classificationFor("JobEvent")!.personalFields).toEqual([]);
    expect(classificationFor("AuditLog")!.personalFields).toEqual([]);
  });
});

describe("retention removes what its purpose no longer needs", () => {
  function job(overrides: Partial<ConstructorParameters<typeof RetentionJob>[0]> = {}) {
    const store = new MemoryStore(developmentSeed);
    const storage = new MockEvidenceStorage("http://localhost:9000", "b", "k".repeat(32), 900);
    const clock = new FixedClock(new Date("2026-09-19T08:00:00.000Z"));
    const metrics = createMetrics();
    return {
      store,
      storage,
      clock,
      metrics,
      retention: new RetentionJob({
        store,
        storage,
        clock,
        metrics,
        config: { evidenceDays: 365, outboxSentDays: 30, idempotencyDays: 7 },
        ...overrides
      })
    };
  }

  it("removes a delivered outbox row once it is old enough", async () => {
    const { store, clock, retention } = job();
    await store.createJob({
      organizationId: developmentSeed.organizations![0]!.id,
      input: VALID_JOB,
      actor: { userId: null, role: "DISPATCHER", correlationId: "t" }
    });

    const claimed = await store.claimOutbox({ now: clock.now(), limit: 10 });
    expect(claimed.length).toBeGreaterThan(0);
    for (const message of claimed) {
      // Delivered two months ago.
      await store.markOutboxDelivered({
        id: message.id,
        now: new Date(clock.now().getTime() - 60 * 24 * 3600_000)
      });
    }

    const result = await retention.run();
    expect(result.outbox).toBe(claimed.length);
    expect((await store.outboxStats()).byStatus.SENT).toBe(0);
  });

  it("never removes a dead letter, however old", async () => {
    const { store, clock, retention } = job();
    await store.createJob({
      organizationId: developmentSeed.organizations![0]!.id,
      input: VALID_JOB,
      actor: { userId: null, role: "DISPATCHER", correlationId: "t" }
    });
    const [message] = await store.claimOutbox({ now: clock.now(), limit: 1 });
    await store.markOutboxFailed({
      id: message!.id,
      error: "gave up",
      now: new Date(clock.now().getTime() - 400 * 24 * 3600_000),
      retryAt: null
    });

    await retention.run();

    // Undelivered work is not tidied away. Somebody still has to deal with it.
    expect((await store.outboxStats()).byStatus.DEAD).toBe(1);
  });

  it("asks storage to delete the object, not only the row", async () => {
    const { store, storage, retention, clock } = job();
    const created = await store.createJob({
      organizationId: developmentSeed.organizations![0]!.id,
      input: VALID_JOB,
      actor: { userId: null, role: "DISPATCHER", correlationId: "t" }
    });
    const evidence = await store.createEvidence({
      jobId: created.id,
      kind: "PICKUP_PHOTO",
      mimeType: "image/jpeg",
      sizeBytes: 1000,
      storageKey: "jobs/x/pickup.jpg",
      actor: { userId: null, role: "DISPATCHER", correlationId: "t" }
    });
    // Two years old.
    (await store.findEvidence(evidence.id, { kind: "staff" }))!.createdAt = new Date(
      clock.now().getTime() - 730 * 24 * 3600_000
    );

    const result = await retention.run();
    expect(result.evidence).toBe(1);
    expect(storage.deleted).toContain("jobs/x/pickup.jpg");
  });

  it("reports an object it could not delete rather than swallowing it", async () => {
    const { store, storage, retention, clock } = job();
    const created = await store.createJob({
      organizationId: developmentSeed.organizations![0]!.id,
      input: VALID_JOB,
      actor: { userId: null, role: "DISPATCHER", correlationId: "t" }
    });
    const evidence = await store.createEvidence({
      jobId: created.id,
      kind: "PICKUP_PHOTO",
      mimeType: "image/jpeg",
      sizeBytes: 1000,
      storageKey: "jobs/x/unreachable.jpg",
      actor: { userId: null, role: "DISPATCHER", correlationId: "t" }
    });
    (await store.findEvidence(evidence.id, { kind: "staff" }))!.createdAt = new Date(
      clock.now().getTime() - 730 * 24 * 3600_000
    );
    storage.delete = async () => {
      throw new Error("bucket unreachable");
    };

    const result = await retention.run();
    // The row is gone and the object is not. That is a leak, and it is named.
    expect(result.orphanedObjects).toEqual(["jobs/x/unreachable.jpg"]);
  });

  it("counts what it removed, so the sweep is visible in metrics", async () => {
    const { store, clock, retention, metrics } = job();
    await store.createJob({
      organizationId: developmentSeed.organizations![0]!.id,
      input: VALID_JOB,
      actor: { userId: null, role: "DISPATCHER", correlationId: "t" }
    });
    const claimed = await store.claimOutbox({ now: clock.now(), limit: 10 });
    for (const message of claimed) {
      await store.markOutboxDelivered({
        id: message.id,
        now: new Date(clock.now().getTime() - 60 * 24 * 3600_000)
      });
    }
    await retention.run();
    expect(metrics.retentionDeletions.get({ kind: "outbox" })).toBe(claimed.length);
  });

  it("is safe to run twice", async () => {
    const { retention } = job();
    const first = await retention.run();
    const second = await retention.run();
    expect(second).toEqual({ ...first, evidence: 0, outbox: 0, idempotency: 0 });
  });
});

describe("erasure severs a person without destroying the records", () => {
  it("overwrites the name, the address and the identity subject", async () => {
    open = await harness();
    const h = open;
    const user = await h.store.findUserBySubject(SUBJECTS.customerMember);
    expect(user).not.toBeNull();

    const result = await h.store.erasePerson({
      userId: user!.id,
      now: h.clock.now(),
      actor: { userId: null, role: "COMPLIANCE", correlationId: "t" }
    });
    expect(result.erased).toBe(true);

    // The old subject no longer resolves: signing in again creates a new
    // person rather than reviving this one.
    expect(await h.store.findUserBySubject(SUBJECTS.customerMember)).toBeNull();
  });

  it("is idempotent, and says so rather than pretending", async () => {
    open = await harness();
    const h = open;
    const user = await h.store.findUserBySubject(SUBJECTS.customerMember);
    await h.store.erasePerson({
      userId: user!.id,
      now: h.clock.now(),
      actor: { userId: null, role: "COMPLIANCE", correlationId: "t" }
    });
    const again = await h.store.erasePerson({
      userId: user!.id,
      now: h.clock.now(),
      actor: { userId: null, role: "COMPLIANCE", correlationId: "t" }
    });
    expect(again.erased).toBe(false);
  });

  it("leaves the jobs, the quotes and the money alone", async () => {
    open = await harness();
    const h = open;
    const customer = await h.auth(SUBJECTS.customerAdmin);
    const created = await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...customer, ...idem() },
      payload: VALID_JOB
    });
    const jobId = created.json().data.job.id as string;

    const user = await h.store.findUserBySubject(SUBJECTS.customerAdmin);
    await h.store.erasePerson({
      userId: user!.id,
      now: h.clock.now(),
      actor: { userId: null, role: "COMPLIANCE", correlationId: "t" }
    });

    // Article 17(3)(b): the commercial record stays. What has gone is the
    // link from it to a named person.
    const job = await h.store.findJob(jobId, { kind: "staff" });
    expect(job).not.toBeNull();
    expect(job!.status).toBe("DRAFT");
    const events = await h.store.listJobEvents(jobId, { kind: "staff" });
    expect(events.length).toBeGreaterThan(0);
  });

  it("records the erasure without recording what was erased", async () => {
    open = await harness();
    const h = open;
    const user = await h.store.findUserBySubject(SUBJECTS.customerMember);
    const before = user!.name;

    await h.store.erasePerson({
      userId: user!.id,
      now: h.clock.now(),
      actor: { userId: null, role: "COMPLIANCE", correlationId: "t" }
    });

    const audit = JSON.stringify(h.store.audit);
    expect(audit).toContain("PERSON_ERASED");
    // The audit log is append-only. A name written here could never be taken
    // back out, which would make the erasure a no-op with extra steps.
    expect(audit).not.toContain(before);
    expect(audit).not.toContain(REDACTED_NAME);
  });
});

describe("only compliance can erase", () => {
  it("refuses a dispatcher, who can see addresses all day", async () => {
    open = await harness();
    const h = open;
    const user = await h.store.findUserBySubject(SUBJECTS.customerMember);
    const response = await h.app.inject({
      method: "POST",
      url: "/v1/privacy/erasure",
      headers: await h.auth(SUBJECTS.dispatcher),
      payload: { userId: user!.id, reason: "customer asked by email on 2026-09-01" }
    });
    expect(response.statusCode).toBe(403);
  });

  it("allows compliance, and explains what it did not delete", async () => {
    open = await harness();
    const h = open;
    const user = await h.store.findUserBySubject(SUBJECTS.customerMember);
    const response = await h.app.inject({
      method: "POST",
      url: "/v1/privacy/erasure",
      headers: await h.auth(SUBJECTS.compliance),
      payload: { userId: user!.id, reason: "customer asked by email on 2026-09-01" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.erased).toBe(true);
    expect(response.json().data.note).toContain("17(3)(b)");
  });

  it("requires a reason, because erasure is irreversible", async () => {
    open = await harness();
    const h = open;
    const user = await h.store.findUserBySubject(SUBJECTS.customerMember);
    const response = await h.app.inject({
      method: "POST",
      url: "/v1/privacy/erasure",
      headers: await h.auth(SUBJECTS.compliance),
      payload: { userId: user!.id }
    });
    expect(response.statusCode).toBe(400);
  });

  it("serves the inventory to compliance and to nobody else", async () => {
    open = await harness();
    const h = open;
    expect(
      (
        await h.app.inject({
          method: "GET",
          url: "/v1/privacy/inventory",
          headers: await h.auth(SUBJECTS.customerAdmin)
        })
      ).statusCode
    ).toBe(403);

    const allowed = await h.app.inject({
      method: "GET",
      url: "/v1/privacy/inventory",
      headers: await h.auth(SUBJECTS.compliance)
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().data.tables.length).toBe(DATA_INVENTORY.length);
  });
});
