import { afterEach, describe, expect, it } from "vitest";
import { Counter, Gauge, Histogram, MetricsRegistry, createMetrics } from "../src/lib/metrics.js";
import { REDACTED_LOG_PATHS } from "../src/lib/redaction.js";
import {
  harness,
  idem,
  jobThroughToQuoted,
  SUBJECTS,
  testConfig,
  VALID_JOB,
  type Harness
} from "./helpers.js";

/**
 * Observability.
 *
 * Two questions, and they pull against each other. Can an operator answer
 * "what is this system doing" -- and can they do it without the logs becoming
 * a second, less protected copy of everyone's address?
 */

let open: Harness | null = null;
afterEach(async () => {
  await open?.close();
  open = null;
});

describe("the exposition format", () => {
  it("renders counters, gauges and histograms a scraper can parse", async () => {
    const registry = new MetricsRegistry();
    const hits = registry.register(new Counter("app_hits_total", "Hits", ["route"]));
    const depth = registry.register(new Gauge("app_queue_depth", "Depth"));
    const latency = registry.register(
      new Histogram("app_latency_seconds", "Latency", [0.1, 1], ["route"])
    );

    hits.increment({ route: "/a" });
    hits.increment({ route: "/a" });
    hits.increment({ route: "/b" }, 5);
    depth.set({}, 3);
    latency.observe({ route: "/a" }, 0.05);
    latency.observe({ route: "/a" }, 2);

    const text = await registry.scrape();

    expect(text).toContain("# TYPE app_hits_total counter");
    expect(text).toContain('app_hits_total{route="/a"} 2');
    expect(text).toContain('app_hits_total{route="/b"} 5');
    expect(text).toContain("app_queue_depth 3");
    // Cumulative buckets: 0.05 is under both, 2 is over both, and _count is
    // the total. Getting this wrong is how a p99 ends up a plausible lie.
    expect(text).toContain('app_latency_seconds_bucket{route="/a",le="0.1"} 1');
    expect(text).toContain('app_latency_seconds_bucket{route="/a",le="1"} 1');
    expect(text).toContain('app_latency_seconds_bucket{route="/a",le="+Inf"} 2');
    expect(text).toContain('app_latency_seconds_count{route="/a"} 2');
    expect(text).toContain('app_latency_seconds_sum{route="/a"} 2.05');
    expect(text.endsWith("\n")).toBe(true);
  });

  it("emits an unlabelled counter at zero, so an alert has a series to watch", async () => {
    const registry = new MetricsRegistry();
    registry.register(new Counter("app_failures_total", "Failures"));
    expect(await registry.scrape()).toContain("app_failures_total 0");
  });

  it("refuses a name a scraper would reject", () => {
    expect(() => new Counter("not a name", "x")).toThrow(/valid metric name/);
  });

  it("refuses buckets that do not ascend", () => {
    expect(() => new Histogram("h", "x", [1, 0.5])).toThrow(/ascend/);
  });

  it("refuses to register the same name twice", () => {
    const registry = new MetricsRegistry();
    registry.register(new Counter("app_x_total", "x"));
    expect(() => registry.register(new Counter("app_x_total", "x"))).toThrow(/already registered/);
  });

  it("escapes a label value rather than producing a broken line", async () => {
    const registry = new MetricsRegistry();
    const counter = registry.register(new Counter("app_odd_total", "Odd", ["note"]));
    counter.increment({ note: 'a "quoted"\nvalue' });
    const text = await registry.scrape();
    expect(text).toContain('note="a \\"quoted\\"\\nvalue"');
    // One line per series, still.
    expect(text.split("\n").filter((line) => line.startsWith("app_odd_total"))).toHaveLength(1);
  });
});

describe("what the API records about itself", () => {
  it("counts requests by route template, never by URL", async () => {
    open = await harness();
    const h = open;
    const { jobId } = await jobThroughToQuoted(h);
    const customer = await h.auth(SUBJECTS.customerAdmin);

    await h.app.inject({ method: "GET", url: `/v1/jobs/${jobId}`, headers: customer });

    const text = await h.app.metrics.registry.scrape();
    // The template, with the parameter unexpanded.
    expect(text).toContain('route="/v1/jobs/:id"');
    // And not the id, which would be one series per job.
    expect(text).not.toContain(jobId);
  });

  it("buckets an unmatched request rather than giving a scanner a series each", async () => {
    open = await harness();
    const h = open;
    for (const path of ["/v1/wp-login.php", "/v1/.env", "/v1/admin.bak"]) {
      await h.app.inject({ method: "GET", url: path });
    }
    const text = await h.app.metrics.registry.scrape();
    expect(text).toContain('route="unmatched"');
    expect(text).not.toContain("wp-login");
    expect(text).not.toContain(".env");
  });

  it("records the status, so a rise in 4xx is visible", async () => {
    open = await harness();
    const h = open;
    await h.app.inject({ method: "GET", url: "/v1/jobs" });
    const text = await h.app.metrics.registry.scrape();
    expect(text).toMatch(/rescue_http_requests_total\{[^}]*status="401"[^}]*\} \d+/);
  });

  it("reports the queue depth from the store, not from a counter in this process", async () => {
    open = await harness();
    const h = open;
    await jobThroughToQuoted(h);

    const before = await h.app.metrics.registry.scrape();
    expect(before).toMatch(/rescue_outbox_messages\{status="PENDING"\} [1-9]/);

    await h.app.outbox.drain();

    const after = await h.app.metrics.registry.scrape();
    expect(after).toMatch(/rescue_outbox_messages\{status="SENT"\} [1-9]/);
    // Everything delivered, so nothing is waiting and the age is zero.
    expect(after).toContain("rescue_outbox_oldest_pending_seconds 0");
  });

  it("counts triage answers by source", async () => {
    open = await harness();
    const h = open;
    await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      payload: VALID_JOB
    });
    const text = await h.app.metrics.registry.scrape();
    expect(text).toMatch(/rescue_triage_answers_total\{source="(model|rules)"\} 1/);
  });

  it("survives a store that cannot answer, because a scrape must not fail", async () => {
    open = await harness();
    const h = open;
    await h.app.inject({ method: "GET", url: "/v1/health" });
    // The one query the collector makes, broken.
    h.store.outboxStats = async () => {
      throw new Error("database is gone");
    };
    const text = await h.app.metrics.registry.scrape();
    expect(text).toContain("rescue_http_requests_total");
  });
});

describe("the scrape endpoint is not public", () => {
  it("is open in development, where there is nothing to protect", async () => {
    open = await harness();
    const response = await open.app.inject({ method: "GET", url: "/metrics" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/plain");
  });

  it("requires the token when one is configured", async () => {
    open = await harness({ config: testConfig({ METRICS_TOKEN: "a-token-long-enough-to-pass" }) });

    expect((await open.app.inject({ method: "GET", url: "/metrics" })).statusCode).toBe(401);
    expect(
      (
        await open.app.inject({
          method: "GET",
          url: "/metrics",
          headers: { authorization: "Bearer wrong-token-of-same-ish-length" }
        })
      ).statusCode
    ).toBe(401);
    expect(
      (
        await open.app.inject({
          method: "GET",
          url: "/metrics",
          headers: { authorization: "Bearer a-token-long-enough-to-pass" }
        })
      ).statusCode
    ).toBe(200);
  });
});

describe("logs are not a second copy of everyone's address", () => {
  /**
   * Driven through the real app's real logger.
   *
   * Redaction is a property of the wiring, not of a list, so a test that
   * builds its own pino with the same options proves only that pino works. A
   * writable stream is handed to `buildApp` and the actual request logs are
   * read back out of it.
   */
  class Capture implements NodeJS.WritableStream {
    lines = "";
    writable = true;
    write(chunk: string | Uint8Array): boolean {
      this.lines += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      return true;
    }
    end(): this {
      return this;
    }
    // Unused by pino, present to satisfy the interface.
    on(): this {
      return this;
    }
    once(): this {
      return this;
    }
    emit(): boolean {
      return true;
    }
    addListener(): this {
      return this;
    }
    removeListener(): this {
      return this;
    }
    off(): this {
      return this;
    }
    removeAllListeners(): this {
      return this;
    }
    setMaxListeners(): this {
      return this;
    }
    getMaxListeners(): number {
      return 0;
    }
    listeners(): [] {
      return [];
    }
    rawListeners(): [] {
      return [];
    }
    listenerCount(): number {
      return 0;
    }
    prependListener(): this {
      return this;
    }
    prependOnceListener(): this {
      return this;
    }
    eventNames(): [] {
      return [];
    }
    setDefaultEncoding(): this {
      return this;
    }
    pipe<T extends NodeJS.WritableStream>(destination: T): T {
      return destination;
    }
  }

  async function loggingHarness(): Promise<{ h: Harness; capture: Capture }> {
    const capture = new Capture();
    const h = await harness({ logStream: capture });
    return { h, capture };
  }

  it("does not log the credential on a rejected request", async () => {
    const { h, capture } = await loggingHarness();
    open = h;
    await h.app.inject({
      method: "GET",
      url: "/v1/jobs",
      headers: { authorization: "Bearer eyJhbGciOi.forged.token" }
    });
    expect(capture.lines).not.toContain("eyJhbGciOi");
    expect(capture.lines).not.toContain("forged");
  });

  it("does not log an address when a request body fails validation", async () => {
    const { h, capture } = await loggingHarness();
    open = h;
    await h.app.inject({
      method: "POST",
      url: "/v1/jobs",
      headers: { ...(await h.auth(SUBJECTS.customerAdmin)), ...idem() },
      // Invalid on purpose: a validation failure is the log line most likely
      // to carry a body.
      payload: { ...VALID_JOB, items: [], pickup: { ...VALID_JOB.pickup, line1: "Sophienstrasse 44" } }
    });
    expect(capture.lines).not.toContain("Sophienstrasse");
  });

  it("keeps the correlation id, which is the whole point of the log", async () => {
    const { h, capture } = await loggingHarness();
    open = h;
    await h.app.inject({
      method: "GET",
      url: "/v1/jobs",
      headers: { "x-request-id": "corr-observability-1" }
    });
    expect(capture.lines).toContain("corr-observability-1");
  });

  it("redacts the same paths wherever they appear, not only under req", async () => {
    const { h, capture } = await loggingHarness();
    open = h;
    h.app.log.info(
      {
        body: { contact: { name: "Anna Klein", phone: "+49 421 555 0100" } },
        vehicle: { registration: "HB-XY 1234" },
        notification: { to: "anna@example.com", body: "Your sofa is at Am Markt 1" },
        jobId: "job-123"
      },
      "deliberate"
    );
    expect(capture.lines).not.toContain("Anna Klein");
    expect(capture.lines).not.toContain("555 0100");
    expect(capture.lines).not.toContain("HB-XY");
    expect(capture.lines).not.toContain("anna@example.com");
    expect(capture.lines).not.toContain("Am Markt");
    // And the operational fields survive, or the log is useless.
    expect(capture.lines).toContain("job-123");
    expect(capture.lines).toContain("[redacted]");
  });

  it("names every redacted path in one list, so a reviewer can read it", () => {
    // Not a behaviour test: a guard against the list quietly shrinking.
    expect(REDACTED_LOG_PATHS.length).toBeGreaterThan(25);
    expect(REDACTED_LOG_PATHS).toContain("req.headers.authorization");
    expect(REDACTED_LOG_PATHS).toContain("contact.phone");
  });
});

describe("the metric set itself", () => {
  it("has no label whose values are unbounded", () => {
    const metrics = createMetrics();
    // Every label in this system is a closed set: a method, a route template,
    // an outcome, a status. If a future metric adds one keyed by an id, this
    // is the test that should stop it -- so the list is written out rather
    // than derived.
    const allowed = new Set([
      "method",
      "route",
      "status",
      "outcome",
      "action",
      "source",
      "result",
      "kind"
    ]);
    for (const metric of metrics.registry.list()) {
      for (const label of metric.labelNames) {
        expect(allowed, `${metric.name} labels by "${label}"`).toContain(label);
      }
    }
  });

  it("registers every metric the app claims to expose", async () => {
    open = await harness();
    const names = open.app.metrics.registry.list().map((metric) => metric.name);
    expect(names).toContain("rescue_outbox_messages");
    expect(names).toContain("rescue_dispatch_sweep_actions_total");
    expect(names).toContain("rescue_retention_deletions_total");
    // Every name is prefixed, so a dashboard can find the whole set.
    expect(names.every((name) => name.startsWith("rescue_"))).toBe(true);
  });
});
