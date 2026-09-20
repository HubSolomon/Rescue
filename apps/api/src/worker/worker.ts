import type { FastifyBaseLogger } from "fastify";
import { OUTBOX_MAX_ATTEMPTS, outboxBackoffMs, type OutboxTopic } from "@rescue/contracts";
import type { Clock } from "../lib/clock.js";
import type { Actor, Store, StoredOutboxMessage } from "../store/types.js";

/**
 * The outbox worker.
 *
 * Claims due messages, hands each to its handler, and records the outcome.
 * Delivery is at-least-once: a handler can run and the process can die before
 * the row is marked delivered, so every handler must be safe to run twice.
 * The alternative -- marking delivered first -- turns a crash into a silently
 * dropped notification, which is the worse failure.
 *
 * A message with no handler is not an error and is not left in the queue
 * either: it is marked delivered with a note. The topic exists, nothing wants
 * it yet, and leaving it PENDING would fill the table with rows that can never
 * succeed.
 */

export type OutboxHandler = (
  message: StoredOutboxMessage,
  context: { actor: Actor; logger: FastifyBaseLogger }
) => Promise<void>;

export type HandlerRegistry = Partial<Record<OutboxTopic, OutboxHandler>>;

export interface WorkerOptions {
  store: Store;
  clock: Clock;
  logger: FastifyBaseLogger;
  handlers: HandlerRegistry;
  /** The actor recorded for anything the worker writes. */
  actor: Actor;
  batchSize?: number;
  pollIntervalMs?: number;
  /**
   * Called after every pass, including the empty ones. Counting only
   * non-empty passes would make a worker that has stopped claiming look
   * identical to a worker with nothing to do.
   */
  onDrain?: (result: DrainResult) => void;
}

export interface DrainResult {
  claimed: number;
  delivered: number;
  failed: number;
  dead: number;
  skipped: number;
}

export class OutboxWorker {
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: WorkerOptions) {}

  /**
   * One pass. Separated from the loop so tests drive it directly: a test that
   * starts a timer and sleeps is a test that is slow and flaky.
   */
  async drain(): Promise<DrainResult> {
    const result: DrainResult = { claimed: 0, delivered: 0, failed: 0, dead: 0, skipped: 0 };
    const now = this.options.clock.now();
    const batch = await this.options.store.claimOutbox({
      now,
      limit: this.options.batchSize ?? 20
    });
    result.claimed = batch.length;

    for (const message of batch) {
      const handler = this.options.handlers[message.topic];
      if (!handler) {
        await this.options.store.markOutboxDelivered({ id: message.id, now: this.options.clock.now() });
        result.skipped += 1;
        continue;
      }

      try {
        await handler(message, { actor: this.options.actor, logger: this.options.logger });
        await this.options.store.markOutboxDelivered({
          id: message.id,
          now: this.options.clock.now()
        });
        result.delivered += 1;
      } catch (error) {
        const attempts = message.attempts + 1;
        const giveUp = attempts >= OUTBOX_MAX_ATTEMPTS;
        const retryAt = giveUp
          ? null
          : new Date(this.options.clock.now().getTime() + outboxBackoffMs(attempts));

        await this.options.store.markOutboxFailed({
          id: message.id,
          error: error instanceof Error ? error.message : String(error),
          now: this.options.clock.now(),
          retryAt
        });

        if (giveUp) {
          result.dead += 1;
          // Loud, because a dead letter is work that will never happen unless
          // a person does something about it.
          this.options.logger.error(
            { outbox: { id: message.id, topic: message.topic, attempts, jobId: message.jobId } },
            "outbox message is dead after the final attempt"
          );
        } else {
          result.failed += 1;
          this.options.logger.warn(
            {
              outbox: {
                id: message.id,
                topic: message.topic,
                attempts,
                retryAt: retryAt?.toISOString()
              }
            },
            "outbox delivery failed; will retry"
          );
        }
      }
    }
    this.options.onDrain?.(result);
    return result;
  }

  /** Starts polling. Idempotent: calling twice does not start two loops. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const interval = this.options.pollIntervalMs ?? 2_000;

    const tick = async () => {
      if (!this.running) return;
      try {
        await this.drain();
      } catch (error) {
        // A failure to claim is infrastructure, not a message problem. Log and
        // keep the loop alive; the next tick will try again.
        this.options.logger.error({ err: error }, "outbox poll failed");
      }
      if (this.running) {
        this.timer = setTimeout(() => void tick(), interval);
        // Do not hold the process open for the sake of the next poll.
        this.timer.unref?.();
      }
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

/**
 * Runs several registries' handlers for the same topic, in order.
 *
 * A job completing both notifies the customer and captures the money, and
 * neither concern should have to know about the other. They share a message
 * rather than each getting their own, because two rows for one event can
 * disagree about whether the event happened.
 *
 * If any handler throws, the message is retried and *all* of them run again.
 * That is why every handler is written to be safe to run twice, and why they
 * are ordered cheapest-first: a notification that has already gone out is a
 * duplicate email, while a payment that runs twice is a real problem, so the
 * payment handlers guard on the ledger rather than on delivery.
 */
export function composeHandlers(...registries: HandlerRegistry[]): HandlerRegistry {
  const composed: HandlerRegistry = {};
  for (const registry of registries) {
    for (const [topic, handler] of Object.entries(registry) as [OutboxTopic, OutboxHandler][]) {
      const existing = composed[topic];
      composed[topic] = existing
        ? async (message, context) => {
            await existing(message, context);
            await handler(message, context);
          }
        : handler;
    }
  }
  return composed;
}
