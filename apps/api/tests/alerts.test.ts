import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMetrics } from "../src/lib/metrics.js";

/**
 * The alert rules and the metrics cannot drift apart.
 *
 * This is the failure mode that makes monitoring worse than useless: a metric
 * is renamed, the rule that watches it silently matches nothing, and the
 * dashboard goes green. Nobody notices, because an alert that never fires
 * looks exactly like a system that is fine.
 *
 * So the rules file is parsed and every `rescue_` series it names is checked
 * against the registry the code actually builds. A rename now fails a test
 * here instead of failing silently at three in the morning.
 */

const ALERTS = readFileSync(join(process.cwd(), "../../deploy/prometheus/alerts.yml"), "utf8");
const EXPORTED = new Set(createMetrics().registry.list().map((metric) => metric.name));

/** Every `rescue_*` identifier the rules reference, histogram suffixes stripped. */
function seriesReferenced(): string[] {
  const names = new Set<string>();
  for (const match of ALERTS.matchAll(/\brescue_[a-z0-9_]+/g)) {
    names.add(match[0].replace(/_(bucket|sum|count)$/, ""));
  }
  return [...names];
}

describe("the alert rules watch series that exist", () => {
  it("names only metrics the code exports", () => {
    const missing = seriesReferenced().filter((name) => !EXPORTED.has(name));
    expect(missing, `alerts.yml watches series nothing exports: ${missing.join(", ")}`).toEqual([]);
  });

  it("watches the four the readiness report singled out", () => {
    const referenced = seriesReferenced();
    for (const name of [
      "rescue_outbox_oldest_pending_seconds",
      "rescue_outbox_messages",
      "rescue_dispatch_sweep_runs_total",
      "rescue_dispatch_sweep_actions_total"
    ]) {
      expect(referenced, `${name} has no alert`).toContain(name);
    }
  });

  it("gives every alert an action and a runbook, not just a summary", () => {
    // An alert whose answer at 3am is "look at it tomorrow" is a dashboard
    // panel. Requiring an action on each one is what keeps the list short.
    const alerts = [...ALERTS.matchAll(/- alert: (\w+)([\s\S]*?)(?=\n      - alert: |\n  - name: |$)/g)];
    expect(alerts.length).toBeGreaterThanOrEqual(10);
    for (const [, name, body] of alerts) {
      expect(body, `${name} has no summary`).toMatch(/summary:/);
      expect(body, `${name} has no action`).toMatch(/action:/);
      expect(body, `${name} has no runbook`).toMatch(/runbook:/);
      expect(body, `${name} has no severity`).toMatch(/severity:/);
    }
  });

  it("points every runbook at a file that exists", () => {
    const root = join(process.cwd(), "../..");
    for (const match of ALERTS.matchAll(/runbook: "([^"#]+)(#[^"]*)?"/g)) {
      const path = join(root, match[1]!);
      expect(() => readFileSync(path, "utf8"), `${match[1]} is missing`).not.toThrow();
    }
  });

  it("uses only page and warn, so severity means something", () => {
    const severities = new Set([...ALERTS.matchAll(/severity: (\w+)/g)].map((m) => m[1]!));
    expect([...severities].sort()).toEqual(["page", "warn"]);
  });
});
