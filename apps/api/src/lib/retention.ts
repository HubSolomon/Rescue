import type { FastifyBaseLogger } from "fastify";
import type { Clock } from "./clock.js";
import type { AppMetrics } from "./metrics.js";
import type { EvidenceStorage } from "./storage.js";
import type { Store } from "../store/types.js";

/**
 * The retention job.
 *
 * Storage limitation -- Article 5(1)(e) -- is the principle a system violates
 * by doing nothing, which is why it is a process and not a policy document.
 * A retention period written in a PDF and enforced by nobody is worse than no
 * period at all: it is a commitment on record that the data will be gone, and
 * a database in which it is not.
 *
 * Three categories, and no others. What the job can remove is derived from
 * the inventory in `privacy.ts`, so a table becomes deletable by being
 * classified as deletable and not by someone adding a query here.
 */

export interface RetentionConfig {
  evidenceDays: number;
  outboxSentDays: number;
  idempotencyDays: number;
}

export interface RetentionResult {
  evidence: number;
  outbox: number;
  idempotency: number;
  /** Objects the storage adapter refused to remove. Not fatal, but not lost. */
  orphanedObjects: string[];
}

function daysBefore(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
}

export class RetentionJob {
  constructor(
    private readonly deps: {
      store: Store;
      clock: Clock;
      storage: EvidenceStorage;
      config: RetentionConfig;
      logger?: FastifyBaseLogger;
      metrics?: AppMetrics;
    }
  ) {}

  async run(): Promise<RetentionResult> {
    const now = this.deps.clock.now();
    const { config } = this.deps;

    const removed = await this.deps.store.runRetention({
      now,
      evidenceOlderThan: daysBefore(now, config.evidenceDays),
      outboxSentOlderThan: daysBefore(now, config.outboxSentDays),
      idempotencyOlderThan: daysBefore(now, config.idempotencyDays)
    });

    /**
     * The row is gone; the object may not be.
     *
     * Deleting the row first is deliberate. The alternative -- object first,
     * then row -- leaves a row pointing at nothing if the process dies in
     * between, and a dangling row is served to a user as a broken photograph.
     * This way a crash leaves an object with no row, which is a leak, so every
     * failure is named in the result and logged at warn rather than swallowed.
     */
    const orphanedObjects: string[] = [];
    for (const key of removed.storageKeys) {
      try {
        await this.deps.storage.delete(key);
      } catch (error) {
        orphanedObjects.push(key);
        this.deps.logger?.warn(
          { key, err: error },
          "evidence row deleted but the object remains; it must be removed by hand"
        );
      }
    }

    const result: RetentionResult = {
      evidence: removed.evidence,
      outbox: removed.outbox,
      idempotency: removed.idempotency,
      orphanedObjects
    };

    this.deps.metrics?.retentionDeletions.increment({ kind: "evidence" }, result.evidence);
    this.deps.metrics?.retentionDeletions.increment({ kind: "outbox" }, result.outbox);
    this.deps.metrics?.retentionDeletions.increment({ kind: "idempotency" }, result.idempotency);

    if (result.evidence + result.outbox + result.idempotency > 0) {
      this.deps.logger?.info({ retention: result }, "retention sweep");
    }
    if (orphanedObjects.length > 0) {
      // Loud on its own line: this is personal data still sitting in a bucket.
      this.deps.logger?.error(
        { count: orphanedObjects.length },
        "retention left objects in storage that could not be deleted"
      );
    }
    return result;
  }
}
