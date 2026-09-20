# Monitoring

The readiness report's first finding was that nothing alerts: every metric
Phase 5 added had to be looked at by someone who already suspected a problem.
This closes it.

## Running it locally

```bash
printf '%s' "$METRICS_TOKEN" > deploy/prometheus/metrics-token
docker compose --profile observability up -d
```

Prometheus on `:9090`, Alertmanager on `:9093`. The profile keeps both out of
`docker compose up -d`, so nobody waits on a monitoring stack to run a test.

With no `METRICS_TOKEN` set, an empty file is fine — outside production the
endpoint is open, and Prometheus sending an empty bearer is harmless.

Check the targets are up at `localhost:9090/targets` before trusting anything
else. **A target that is down produces no series, and an alert on a series that
does not exist never fires** — which on a dashboard is indistinguishable from
a healthy system. That single confusion is the most common way monitoring
fails, so it is the first thing to verify and the first thing to check when an
incident was not caught.

## Two targets, not one

The API and the worker are separate processes and export different things. The
API has the HTTP series; **the dispatch sweep and the retention job run only in
the worker**, so their counters exist only there.

Scraping the API alone — the obvious mistake, because it is the process with a
URL people know — leaves every alert about dispatch and retention permanently
pending. The worker therefore serves `/metrics` and `/health` on
`WORKER_METRICS_PORT` (4001 by default, 0 to disable). It is a separate tiny
server rather than the worker's own app, because that app carries the full
`/v1` surface and publishing a second unauthenticated copy of the API from a
process nobody expects to serve traffic would be a much larger mistake than
the one it fixes.

The queue-depth gauges appear on both, because both read them from the database
at scrape time. That is deliberate: the number is a property of the queue, not
of a process, so either answer is correct and neither goes stale on a restart.

## The rules

Eleven, across three groups. Two principles kept the list that short:

**An alert must correspond to an action.** If the answer to "what do I do about
this at 3am" is "look at it tomorrow", it is a dashboard panel. Every rule
carries an `action` annotation and a `runbook` link to the section that
describes it, and `alerts.test.ts` fails the build if one does not.

**An alert must not fire on a healthy system.** A rule that cries wolf weekly
gets muted, and a muted rule is worse than no rule because it looks like
coverage. Every threshold is set against the system's own configured timings —
a two-second outbox poll, a one-minute sweep, a twenty-minute offer TTL —
rather than a round number.

The ones that matter most:

| Alert | Why it is the one to watch |
| --- | --- |
| `OutboxBacklogGrowing` | Age, not depth. A deep queue that is draining is fine; a shallow one that is not draining is not. |
| `OutboxDeadLetters` | Work that will never happen unless a person acts. No healthy non-zero value, so no threshold to tune. |
| `DispatchEscalation` | Escalations go to a null recipient today. **This alert is currently the only way anyone finds out** — see limitation 5 in the readiness report. |
| `DispatchSweepStopped` | A dead worker looks exactly like a quiet hour. Silence is the symptom. |

## Severity

Only `page` and `warn`, and they must not go to the same place. A warning that
arrives the same way as a page trains people to ignore pages, and that takes
about a week. The routing in `alertmanager.yml` enforces the split; the
inhibit rules stop one outage producing three pages.

## What is still not done

**The receivers are placeholders.** `alertmanager.yml` routes correctly and
delivers nowhere. An Alertmanager with no receiver accepts every alert and
drops it silently, which is the worst state to be in because the rules show as
loaded. Fill in PagerDuty and Slack, then prove it:

```bash
amtool alert add alertname=Test severity=page --alertmanager.url=http://localhost:9093
```

Until that test alert has arrived on someone's phone, this directory is a
well-reasoned configuration file and not monitoring.

**No Grafana.** Prometheus's own expression browser is enough to read these
series, and a dashboard nobody has agreed on is a maintenance burden rather
than an asset.

**No recording rules.** The ratio expressions recompute on every evaluation.
At this volume that is free; revisit if the series count grows.
