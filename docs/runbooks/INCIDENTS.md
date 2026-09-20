# Incident runbook

For the person who has just been paged and has not read this before.

Every metric named here is one the system actually exposes; every command has
been run. Where something cannot be diagnosed with what exists today, it says
so rather than describing a dashboard nobody has built.

## 0. First two minutes

```bash
curl -fsS "$API/health"   # is the process alive
curl -fsS "$API/ready"    # should traffic go here
curl -fsS -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep ^rescue_
```

`/health` touches nothing, so it stays green while the database is down — that
is deliberate, and it means a green `/health` with a red `/ready` is a
dependency problem, not a process problem.

The three numbers worth reading before anything else:

```
rescue_outbox_oldest_pending_seconds     climbing = deliveries are not keeping up
rescue_outbox_messages{status="DEAD"}    non-zero = work that will never happen
rescue_dispatch_sweep_runs_total{outcome="error"}   rising = offers are not expiring
```

Every log line carries `reqId`. It is the `x-request-id` the caller sent, or one
generated, and it comes back on the response header — so a customer complaint
with a request id is directly greppable.

## 1. "Nobody is being notified"

**Symptom:** jobs move, emails do not arrive.

The outbox is a projection of the event stream, so the transition and the
intent to notify are written in one transaction. If the job moved, the row
exists. The question is only whether anything is draining it.

```bash
curl -s -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" \
  | grep -E 'rescue_outbox_(messages|oldest)'
```

- **PENDING climbing, `outbox_messages_total` flat** → no worker is running.
  `pnpm --filter @rescue/api dev:worker`, or the worker container has crashed.
  Check that it has `DATABASE_URL`: without one it starts with its own
  in-memory store, warns loudly, and shares nothing with the API.
- **FAILED climbing** → the handler is throwing. Five attempts with exponential
  backoff, so a transient provider outage self-heals; a persistent one becomes
  dead letters in about an hour.
- **DEAD non-zero** → this is the one that needs a person.

```sql
SELECT topic, count(*), max("lastError")
FROM "OutboxMessage" WHERE status = 'DEAD' GROUP BY topic;
```

Dead letters are never swept by retention and never deleted automatically,
precisely so this query works weeks later. To retry one after fixing the cause:

```sql
UPDATE "OutboxMessage"
SET status = 'PENDING', attempts = 0, "availableAt" = now()
WHERE id = '<id>';
```

That is an `UPDATE` on the outbox, which is allowed — the outbox is a work
queue, not an audit log.

## 2. "A job has been sitting in QUOTED for hours"

The dispatch sweep expires offers and covers the jobs they uncovered: three
rounds of three providers, then it escalates and stops.

```bash
grep '"escalation"' worker.log | tail -20
```

**Escalations go to a null recipient.** There is no on-call address in the
system, so the development sender logs them and nothing reaches a human. Until
that is fixed, an escalation is only visible in the log or in
`rescue_dispatch_sweep_actions_total{action="escalated"}`. Alert on that
counter — it is currently the only way anyone finds out.

If the sweep is not running at all, `rescue_dispatch_sweep_runs_total` stops
increasing. It lives in the worker process, so it dies with the worker, and the
symptom is offers that display as *Abgelaufen* while the row still says
`PENDING`.

## 3. "Money looks wrong"

There is no balance column anywhere, by design. Every figure is a fold:

```sql
SELECT kind, count(*), sum("amountCents")
FROM "LedgerEntry" WHERE "jobId" = '<jobId>' GROUP BY kind;
```

Signed from RESCUE's point of view: money in positive, money out negative, so
`sum("amountCents")` across a job is the margin and across everything is the
position.

**Do not correct a ledger entry.** `UPDATE` and `DELETE` are refused by
trigger, and that is the point. A correction is a new, opposite entry —
`REFUND` against a `CAPTURE`, `PAYOUT_REVERSAL` against a `PAYOUT`. A ledger
whose history can be edited is not evidence of anything.

Payment handlers guard on the ledger rather than on delivery, so a duplicated
outbox message does not double-charge. If a duplicate charge appears, that
guard is the thing to look at.

## 4. "Distances look wrong"

```bash
curl -s -H "Authorization: Bearer $METRICS_TOKEN" "$API/metrics" | grep maps_lookups
```

`result="estimate"` rising means the OpenStreetMap provider is unreachable and
the postal-code fallback is answering. That is degraded but safe: the answer
carries `isRoadDistance: false`, which reaches the dispatcher console as
`distanceIsRoad`, so a guess is never displayed as a measurement.

Eligibility uses the distance, so a provider that should be in range may be
excluded while this lasts. It is a correctness question, not only a display
one.

Nominatim's usage policy asks for caching and at most one request a second.
If the cache is cold after a restart, a burst of lookups can get the deployment
blocked — which looks exactly like the provider being down.

## 5. "Someone says the AI decided something"

It did not, and this is checkable rather than reassuring.

```sql
SELECT type, "actorId", "createdAt" FROM "JobEvent"
WHERE "jobId" = '<jobId>' ORDER BY "createdAt";
```

Every transition carries an actor. The suggestion, separately:

```sql
SELECT "promptId", "promptVersion", model, confidence, "fellBackToRules", output
FROM "Suggestion" WHERE "jobId" = '<jobId>';
```

A suggestion is recorded whether or not anyone acted on it, so "what did it
propose" and "what did a person do" are two different rows and can be compared.
`requiresHumanApproval` is typed `z.literal(true)`: a model claiming otherwise
produces an invalid suggestion that is discarded entirely, not an overreaching
one.

`apps/api/tests/human-in-the-loop.test.ts` proves the general claim three ways;
the queries above answer it for one job.

## 6. "We need to erase someone, today"

```bash
curl -X POST "$API/v1/privacy/erasure" \
  -H "Authorization: Bearer $COMPLIANCE_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"userId":"<uuid>","reason":"request received by email 2026-09-01"}'
```

Compliance or admin only, reason mandatory and stored. It severs rather than
deletes: name, email and the identity-provider subject are overwritten, and the
subject becomes a value no provider can issue, so the same person signing in
again becomes a new person.

Jobs, quotes and ledger entries stay — Article 17(3)(b). If the requester
expects the database to be emptied, the response text says why it is not.

Idempotent: a second call returns `erased: false`.

## 7. Suspected credential compromise

In order, because the order matters:

1. **Rotate `JWT_SECRET`.** Every issued token stops verifying. Everyone is
   signed out; that is the intended effect.
2. **Do not rotate `REGISTRATION_HASH_KEY`** in the same motion. It keys the
   vehicle-registration hashes, and rotating it makes every stored hash
   permanently unmatchable. If it is the compromised one, that is a data
   migration, not an incident action.
3. Rotate `METRICS_TOKEN` and the S3 credentials.
4. `node scripts/scan-secrets.mjs` on the working tree.
5. If the value was ever committed, **rotate first**. Removing the commit does
   not unpublish it.

## 8. Rolling back a deployment

The API is stateless; roll the image back. Migrations are the constraint:

- Every migration to date is additive — new tables, new columns, new triggers.
  An older image runs against a newer schema.
- **There is no down migration for any of them**, and none is planned. Rolling
  the schema back means restoring a dump, which means losing everything since
  it. If a migration ever drops or renames a column, that property is gone and
  the deployment needs a two-step plan instead.

## 9. What this runbook cannot help with

- **No alerting.** Every number here has to be looked at by someone who already
  suspects a problem. There is no Alertmanager rule, no paging, no threshold.
- **No log aggregation.** `grep worker.log` assumes you can reach the host.
- **No dashboards.** `/metrics` is a scrape endpoint with no Prometheus
  configured to scrape it.
- **No load test**, so none of the numbers here have a known normal. "Climbing"
  is a judgement call until someone establishes a baseline.
