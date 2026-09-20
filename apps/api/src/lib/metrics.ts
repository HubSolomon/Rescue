/**
 * Metrics, in the Prometheus text format, with no dependency.
 *
 * A client library would be four hundred kilobytes and a supply-chain entry to
 * do what four hundred lines do here, and the exposition format is stable and
 * specified. The constraint that matters is not size, though: it is that every
 * metric in this file had to be named and bounded by hand, which is the only
 * reliable defence against the failure mode of instrumentation -- a label whose
 * values are unbounded, so the series count grows with traffic until the
 * scraper falls over. Every `labelNames` here is a closed set, and the one
 * label that could have been open (the HTTP route) carries the route *template*
 * Fastify matched, never the URL the caller sent.
 */

export type Labels = Record<string, string>;

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;

function assertName(name: string): void {
  if (!NAME.test(name)) throw new Error(`Not a valid metric name: ${name}`);
}

/**
 * Escaping per the exposition format: backslash, newline and double quote.
 * A label value here comes from our own code, but a metrics endpoint that can
 * be broken by an unexpected character is a metrics endpoint that goes down
 * during exactly the incident it was installed for.
 */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function keyOf(labelNames: readonly string[], labels: Labels): string {
  return labelNames.map((name) => labels[name] ?? "").join("\u0000");
}

function renderLabels(labelNames: readonly string[], key: string): string {
  if (labelNames.length === 0) return "";
  const values = key.split("\u0000");
  const pairs = labelNames.map((name, index) => `${name}="${escapeLabelValue(values[index] ?? "")}"`);
  return `{${pairs.join(",")}}`;
}

interface Metric {
  readonly name: string;
  readonly help: string;
  readonly type: "counter" | "gauge" | "histogram";
  render(): string[];
}

export class Counter implements Metric {
  readonly type = "counter" as const;
  private readonly values = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[] = []
  ) {
    assertName(name);
  }

  increment(labels: Labels = {}, by = 1): void {
    const key = keyOf(this.labelNames, labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  get(labels: Labels = {}): number {
    return this.values.get(keyOf(this.labelNames, labels)) ?? 0;
  }

  render(): string[] {
    // A counter with no observations is emitted at zero when it has no labels.
    // An alert on `rate(x[5m])` against a series that does not exist yet is an
    // alert that does not fire, which is the quiet kind of monitoring failure.
    if (this.values.size === 0 && this.labelNames.length === 0) return [`${this.name} 0`];
    return [...this.values.entries()].map(
      ([key, value]) => `${this.name}${renderLabels(this.labelNames, key)} ${value}`
    );
  }
}

export class Gauge implements Metric {
  readonly type = "gauge" as const;
  private readonly values = new Map<string, number>();

  constructor(
    readonly name: string,
    readonly help: string,
    readonly labelNames: readonly string[] = []
  ) {
    assertName(name);
  }

  set(labels: Labels, value: number): void {
    this.values.set(keyOf(this.labelNames, labels), value);
  }

  get(labels: Labels = {}): number {
    return this.values.get(keyOf(this.labelNames, labels)) ?? 0;
  }

  render(): string[] {
    if (this.values.size === 0 && this.labelNames.length === 0) return [`${this.name} 0`];
    return [...this.values.entries()].map(
      ([key, value]) => `${this.name}${renderLabels(this.labelNames, key)} ${value}`
    );
  }
}

interface HistogramSeries {
  counts: number[];
  sum: number;
  count: number;
}

export class Histogram implements Metric {
  readonly type = "histogram" as const;
  private readonly series = new Map<string, HistogramSeries>();

  constructor(
    readonly name: string,
    readonly help: string,
    private readonly buckets: readonly number[],
    readonly labelNames: readonly string[] = []
  ) {
    assertName(name);
    for (let i = 1; i < buckets.length; i += 1) {
      if (buckets[i]! <= buckets[i - 1]!) throw new Error(`${name}: buckets must ascend`);
    }
  }

  observe(labels: Labels, value: number): void {
    const key = keyOf(this.labelNames, labels);
    let entry = this.series.get(key);
    if (!entry) {
      entry = { counts: new Array(this.buckets.length).fill(0), sum: 0, count: 0 };
      this.series.set(key, entry);
    }
    entry.sum += value;
    entry.count += 1;
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (value <= this.buckets[i]!) entry.counts[i] = entry.counts[i]! + 1;
    }
  }

  render(): string[] {
    const lines: string[] = [];
    for (const [key, entry] of this.series) {
      const base = renderLabels(this.labelNames, key);
      const withLe = (le: string): string => {
        const inner = base === "" ? "" : base.slice(1, -1) + ",";
        return `{${inner}le="${le}"}`;
      };
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i += 1) {
        // Buckets are cumulative in the exposition format, and `observe`
        // already counted every bucket the value falls under, so the count is
        // taken as-is rather than summed again.
        cumulative = entry.counts[i]!;
        lines.push(`${this.name}_bucket${withLe(String(this.buckets[i]))} ${cumulative}`);
      }
      lines.push(`${this.name}_bucket${withLe("+Inf")} ${entry.count}`);
      lines.push(`${this.name}_sum${base} ${entry.sum}`);
      lines.push(`${this.name}_count${base} ${entry.count}`);
    }
    return lines;
  }
}

/**
 * The registry.
 *
 * Gauges that describe stored state -- how many outbox rows are dead right now
 * -- cannot be maintained by incrementing, because a second process changes
 * them and a restart forgets them. They are registered as collectors instead
 * and read at scrape time.
 */
export class MetricsRegistry {
  private readonly metrics: Metric[] = [];
  private readonly collectors: Array<() => Promise<void>> = [];

  register<T extends Metric>(metric: T): T {
    if (this.metrics.some((existing) => existing.name === metric.name)) {
      throw new Error(`Metric already registered: ${metric.name}`);
    }
    this.metrics.push(metric);
    return metric;
  }

  /** Every registered metric, for tests that assert on the shape of the set. */
  list(): ReadonlyArray<{ name: string; labelNames: readonly string[] }> {
    return this.metrics.map((metric) => ({
      name: metric.name,
      labelNames: (metric as { labelNames?: readonly string[] }).labelNames ?? []
    }));
  }

  /** Run before each scrape, to refresh gauges that describe stored state. */
  onCollect(collect: () => Promise<void>): void {
    this.collectors.push(collect);
  }

  async scrape(): Promise<string> {
    for (const collect of this.collectors) await collect();
    const lines: string[] = [];
    for (const metric of this.metrics) {
      const rendered = metric.render();
      if (rendered.length === 0) continue;
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      lines.push(`# TYPE ${metric.name} ${metric.type}`);
      lines.push(...rendered);
    }
    return lines.join("\n") + "\n";
  }
}

/** Seconds. Tuned for an HTTP API in front of one database, not for a CDN. */
export const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

export interface AppMetrics {
  registry: MetricsRegistry;
  httpRequests: Counter;
  httpDuration: Histogram;
  outboxOutcomes: Counter;
  outboxByStatus: Gauge;
  outboxOldestPendingSeconds: Gauge;
  sweepRuns: Counter;
  sweepActions: Counter;
  triageFallbacks: Counter;
  mapsLookups: Counter;
  retentionDeletions: Counter;
}

export function createMetrics(): AppMetrics {
  const registry = new MetricsRegistry();
  return {
    registry,
    httpRequests: registry.register(
      new Counter("rescue_http_requests_total", "HTTP requests by route template and status class", [
        "method",
        "route",
        "status"
      ])
    ),
    httpDuration: registry.register(
      new Histogram(
        "rescue_http_request_duration_seconds",
        "HTTP request duration by route template",
        LATENCY_BUCKETS,
        ["method", "route"]
      )
    ),
    outboxOutcomes: registry.register(
      new Counter(
        "rescue_outbox_messages_total",
        "Outbox messages processed by this worker, by outcome",
        ["outcome"]
      )
    ),
    outboxByStatus: registry.register(
      new Gauge("rescue_outbox_messages", "Outbox rows currently in each status", ["status"])
    ),
    outboxOldestPendingSeconds: registry.register(
      new Gauge(
        "rescue_outbox_oldest_pending_seconds",
        "Age of the oldest undelivered outbox row. The number that says whether delivery is keeping up"
      )
    ),
    sweepRuns: registry.register(
      new Counter("rescue_dispatch_sweep_runs_total", "Dispatch sweep passes, by outcome", ["outcome"])
    ),
    sweepActions: registry.register(
      new Counter(
        "rescue_dispatch_sweep_actions_total",
        "What the sweep did, by kind: offers expired, offers re-sent, jobs escalated",
        ["action"]
      )
    ),
    triageFallbacks: registry.register(
      new Counter(
        "rescue_triage_answers_total",
        "Triage answers by source. A rising rules share means the model is failing quietly",
        ["source"]
      )
    ),
    mapsLookups: registry.register(
      new Counter(
        "rescue_maps_lookups_total",
        "Distance lookups by result: a road distance, a cached answer, or the offline estimate",
        ["result"]
      )
    ),
    retentionDeletions: registry.register(
      new Counter("rescue_retention_deletions_total", "Records removed by the retention job, by kind", [
        "kind"
      ])
    )
  };
}
