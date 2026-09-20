import Fastify from "fastify";
import { buildApp } from "../app.js";
import { config } from "../config.js";
import { systemClock } from "../lib/clock.js";
import { metricsRoutes } from "../routes/metrics.js";

/**
 * The worker process.
 *
 * A separate entry point from the API, sharing its wiring. Running it in its
 * own process is the point: a slow notification provider must not add latency
 * to a dispatcher's request, and a worker crash must not take the API with it.
 * Deployed as a second container against the same database.
 *
 * It is safe to run several. Claims use SKIP LOCKED, so two workers take
 * disjoint batches, and the sweep is idempotent -- expiring an already expired
 * offer is a no-op and re-covering a covered job is skipped.
 */

async function main(): Promise<void> {
  // The app is built but never listens: this process wants the wiring, the
  // store and the worker, not an HTTP server.
  const app = await buildApp();
  const log = app.log.child({ process: "worker" });

  log.info(
    {
      pollIntervalMs: config.OUTBOX_POLL_MS,
      batchSize: config.OUTBOX_BATCH,
      sweepIntervalMs: config.SWEEP_INTERVAL_MS,
      store: config.DATABASE_URL ? "postgres" : "memory"
    },
    "worker starting"
  );

  if (!config.DATABASE_URL) {
    // Worth saying plainly: with the in-memory store the worker has its own
    // copy of the data and will find nothing the API wrote.
    log.warn("DATABASE_URL is unset; this worker shares no state with the API process");
  }

  app.outbox.start();

  /**
   * A listener for the scraper, and nothing else.
   *
   * The sweep and retention counters live in THIS process, so without a
   * listener they never reach Prometheus and every alert about dispatch or
   * retention stays permanently pending -- which on a dashboard is
   * indistinguishable from healthy.
   *
   * Its own tiny Fastify rather than `app.listen()`: the worker's app carries
   * the full `/v1` surface, and publishing a second unauthenticated copy of
   * the API from a process nobody expects to serve traffic would be a much
   * larger mistake than the one this fixes. Only `/metrics` and `/health`, and
   * `/metrics` keeps the same token rule it has on the API.
   */
  let metricsServer: ReturnType<typeof Fastify> | null = null;
  if (config.WORKER_METRICS_PORT > 0) {
    const token = config.METRICS_TOKEN ?? null;
    if (token === null && config.NODE_ENV === "production") {
      log.warn("METRICS_TOKEN is unset in production; the worker will not expose /metrics");
    } else {
      metricsServer = Fastify({ logger: false });
      await metricsServer.register(metricsRoutes({ registry: app.metrics.registry, token }));
      metricsServer.get("/health", async () => ({ status: "ok", service: "rescue-worker" }));
      await metricsServer.listen({ port: config.WORKER_METRICS_PORT, host: config.API_HOST });
      log.info({ port: config.WORKER_METRICS_PORT }, "worker metrics listening");
    }
  }

  const sweepTick = async () => {
    try {
      const result = await app.sweep.run(app.systemActor);
      app.metrics.sweepRuns.increment({ outcome: "ok" });
      app.metrics.sweepActions.increment({ action: "expired" }, result.expired);
      app.metrics.sweepActions.increment({ action: "reoffered" }, result.reoffered.length);
      app.metrics.sweepActions.increment({ action: "escalated" }, result.escalated.length);
      if (result.expired > 0 || result.reoffered.length > 0 || result.escalated.length > 0) {
        log.info({ sweep: result }, "dispatch sweep");
      }
      for (const escalation of result.escalated) {
        log.warn({ escalation }, "job needs a dispatcher");
      }
    } catch (error) {
      // Counted, not just logged: a sweep that has been failing for an hour
      // looks exactly like a quiet hour from the outside.
      app.metrics.sweepRuns.increment({ outcome: "error" });
      log.error({ err: error }, "dispatch sweep failed");
    }
  };

  const sweepTimer = setInterval(() => void sweepTick(), config.SWEEP_INTERVAL_MS);
  void sweepTick();

  /**
   * Retention, once a day.
   *
   * Storage limitation is violated by doing nothing, so this runs on a timer
   * in the same process rather than as a cron job someone has to remember to
   * install. Daily because every window here is measured in days: running it
   * hourly would delete the same nothing twenty-three extra times.
   */
  const retentionTick = async () => {
    try {
      await app.retention.run();
    } catch (error) {
      log.error({ err: error }, "retention sweep failed");
    }
  };
  const retentionTimer = setInterval(() => void retentionTick(), 24 * 60 * 60 * 1000);
  void retentionTick();

  const shutdown = async (signal: string) => {
    log.info({ signal }, "worker stopping");
    clearInterval(sweepTimer);
    clearInterval(retentionTimer);
    // Stop claiming, then close. In-flight deliveries finish; anything claimed
    // and not marked delivered returns to the queue when its lease expires.
    await app.outbox.stop();
    await metricsServer?.close();
    await app.close();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  log.info({ startedAt: systemClock.now().toISOString() }, "worker ready");
}

void main().catch((error) => {
  console.error("worker failed to start", error);
  process.exit(1);
});
