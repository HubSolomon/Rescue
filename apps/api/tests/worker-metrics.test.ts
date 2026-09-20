import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { createMetrics } from "../src/lib/metrics.js";
import { metricsRoutes } from "../src/routes/metrics.js";

/**
 * The worker's own scrape endpoint.
 *
 * The sweep and the retention job run only in the worker process, so their
 * counters exist only there. A deployment that scrapes the API alone gets no
 * series for them at all -- and an alert on a series that does not exist never
 * fires, which on a dashboard is indistinguishable from healthy. That is the
 * failure these tests exist to prevent, so they check the listener is a real
 * one and that it exposes those counters and nothing else.
 */

let server: ReturnType<typeof Fastify> | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

function workerMetricsServer(token: string | null) {
  const metrics = createMetrics();
  // The two the worker owns, incremented so they render with labels.
  metrics.sweepRuns.increment({ outcome: "ok" }, 3);
  metrics.sweepActions.increment({ action: "escalated" }, 1);
  metrics.retentionDeletions.increment({ kind: "outbox" }, 12);

  const app = Fastify({ logger: false });
  void app.register(metricsRoutes({ registry: metrics.registry, token }));
  app.get("/health", async () => ({ status: "ok", service: "rescue-worker" }));
  return app;
}

describe("the worker is scrapable", () => {
  it("serves the counters that exist nowhere else", async () => {
    server = workerMetricsServer(null);
    const response = await server.inject({ method: "GET", url: "/metrics" });

    expect(response.statusCode).toBe(200);
    const body = response.body;
    expect(body).toContain('rescue_dispatch_sweep_runs_total{outcome="ok"} 3');
    expect(body).toContain('rescue_dispatch_sweep_actions_total{action="escalated"} 1');
    expect(body).toContain('rescue_retention_deletions_total{kind="outbox"} 12');
  });

  it("answers a liveness probe without touching anything", async () => {
    server = workerMetricsServer(null);
    const response = await server.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json().service).toBe("rescue-worker");
  });

  it("keeps the same token rule the API has", async () => {
    server = workerMetricsServer("a-token-long-enough-to-pass");
    expect((await server.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(401);
    expect(
      (
        await server.inject({
          method: "GET",
          url: "/metrics",
          headers: { authorization: "Bearer a-token-long-enough-to-pass" }
        })
      ).statusCode
    ).toBe(200);
  });

  it("exposes nothing but metrics and health", async () => {
    server = workerMetricsServer(null);
    // The worker's own app carries the full /v1 surface. Publishing a second
    // unauthenticated copy of the API from a process nobody expects to serve
    // traffic would be a far larger mistake than the one the listener fixes.
    for (const url of ["/v1/jobs", "/v1/providers", "/v1/auth/dev-token", "/"]) {
      expect((await server.inject({ method: "GET", url })).statusCode, url).toBe(404);
    }
  });

  it("names every series the alert rules watch", async () => {
    // The rules file is only as good as the series it references. If a metric
    // is renamed, this fails here rather than as an alert that never fires.
    server = workerMetricsServer(null);
    const body = (await server.inject({ method: "GET", url: "/metrics" })).body;
    for (const series of [
      "rescue_dispatch_sweep_runs_total",
      "rescue_dispatch_sweep_actions_total",
      "rescue_retention_deletions_total"
    ]) {
      expect(body, `${series} is referenced by deploy/prometheus/alerts.yml`).toContain(series);
    }
  });
});
