# Release readiness

**Branch:** `claude/phase-3-frontend` · **Date:** 2026-09-19
**Baseline:** `b6a0b96` · **Covers:** Phase 5 — observability, data protection,
supply chain, threat model, runbooks.

## Verdict

**Ready for a supervised pilot in Bremen. Not ready to be left alone.**

The distinction is precise and it is not about code quality. Everything a
request touches is built, tested and defensible. What is missing is everything
that happens when nobody is looking: no alert fires, no backup runs, no
escalation reaches a person, and two of the four external adapters have never
spoken to a real provider.

A pilot where a named operator watches the console during working hours is a
reasonable next step, and the thing most likely to be learned from it is which
of the gaps below actually bite.

## 1. What this phase added

**Metrics**, in Prometheus format, with no dependency. The constraint enforced
throughout is cardinality, not size: every label is a closed set, HTTP series
carry the route template Fastify matched rather than the URL, and an unmatched
request is bucketed as `unmatched` so a scanner walking random paths cannot
grow the series count. Queue depth is a collector, not a counter — a second
worker changes it and a restart forgets it, so `outboxStats()` is a query, in
the conformance suite, on both stores. A dead letter counts as undelivered, or
the age metric looks healthy exactly when it is not.

`/metrics` is not public: with a token it demands one in constant time, and
without a token it does not exist in production.

**Redacted logs.** Configured on the logger, not at call sites, because a call
site can be forgotten. Tested by driving real requests through the real app
logger into a captured stream — a test that builds its own pino with the same
options proves only that pino works.

**A data inventory the schema is held to.** Typed, not a document. A table added
without a classification fails the build; a classification naming a field that
no longer exists fails too. It documents the structural decision the system was
already built around and now enforces: one table holds a name, so erasure is
three columns on one row rather than a migration. The corollary — no event
payload carries an address — has a test, because `JobEvent` is append-only and
anything personal written there could never be taken out.

**Retention that runs**, daily, in the worker. Evidence at a year, delivered
outbox rows at thirty days, idempotency records at seven, and never a dead
letter. The row is deleted before the object, because the reverse serves users
a broken photograph; a storage failure is returned, logged at error and named
for manual removal rather than swallowed.

**Erasure that severs.** Name, email and the OIDC subject overwritten, the
subject replaced with a value no provider can issue. Jobs, quotes and ledger
stay — Article 17(3)(b) — and the response says so, because the usual
expectation is that erasure empties the database.

**CI that runs the half of the suite that never ran.** A `postgres:16` service
job executes the Prisma conformance suite, which skips itself everywhere else.
A browser job with a lockfile-keyed cache and traces uploaded on failure. A
dependency-free secret scanner that runs *before* `pnpm install`.

**A threat model and two runbooks**, both executed rather than written.

## 2. The finding

**Append-only did not survive `TRUNCATE`.**

Found during the backup drill, by trying to destroy the data and noticing it
worked. The guards on `JobEvent`, `AuditLog`, `LedgerEntry` and `Suggestion`
were row-level `BEFORE UPDATE OR DELETE` triggers, and PostgreSQL does not fire
row-level triggers for `TRUNCATE` — there are no rows, only a file being
replaced. One statement could have emptied the audit log, and nothing would
have recorded it, because the record is one of the tables.

Verified before the fix: `UPDATE` refused, `DELETE` refused, `TRUNCATE
"JobEvent"` succeeded and returned zero rows.

Migration `20260919000400_truncate_guard` adds statement-level triggers.
Verified after: a direct truncate is refused, and `TRUNCATE "Job" CASCADE` —
which would have taken the events, the ledger and the suggestions — is refused
by the children's guards and rolls back entirely.

This is worth dwelling on. The property had a migration, a comment explaining
it, and tests asserting `UPDATE` and `DELETE` were refused. It was still wrong,
and no amount of reading would have found it. The drill did.

## 3. Verification

| | |
| --- | --- |
| API | 314 passing, 3 skipped |
| Web | 51 passing |
| End-to-end | 26 passing — 13 journeys × desktop Chromium and Pixel 7 |
| Database invariants | 37 checks, 0 failed, against PostgreSQL 16.13 |
| Secret scan | clean, 165 files |
| Typecheck, lint, build | clean |

Skipped: `PrismaStore` conformance, and two live map checks.

The 37 database checks are `scripts/check-database.sh`, and they ask a question
the application suite cannot. Those 314 tests pass against the in-memory store,
which enforces the rules in TypeScript; this asks whether PostgreSQL still
refuses when something reaches it another way — a migration, a support query, a
second service. Every case is written so it would *succeed* if the rule were
missing: 13 CHECK constraints, 8 append-only triggers, the 4 `TRUNCATE` guards
and the cascade from `Job`, the outbox's delivered-iff-sent pair, and the legal
cases too, because a constraint that also blocks correct behaviour is a bug a
refusal-only suite never finds.

The concurrency case is two real sessions: the second claims while the first
still holds its lock, and they must come back disjoint. They did — `c1 c2 c3`
against `c4 c5 c6`. If `FOR UPDATE SKIP LOCKED` were wrong, every notification
would go out twice and nothing else here would notice.

Also executed against real PostgreSQL 16.13: all five migrations, and a full
`pg_dump` / `pg_restore` cycle with 17 tables, 8 triggers and ledger amounts
exact after restore.

## 4. What is not done

Ranked by what would hurt first.

**1. ~~Nothing alerts~~ — nothing is *delivered*.** Closed in part: eleven
alert rules now exist in `deploy/prometheus/`, with a scrape config, compose
wiring under an `observability` profile, and a test that holds every rule to
the metrics the code exports so a rename fails the build instead of silently
matching nothing.

Writing them found a hole in Phase 5. The dispatch sweep and the retention job
run **only in the worker**, and the worker never listened — so those counters
reached no scraper and every alert about dispatch or retention would have sat
permanently pending, which on a dashboard is indistinguishable from healthy.
The worker now serves `/metrics` and `/health` on `WORKER_METRICS_PORT`.

What remains is the last mile: **the Alertmanager receivers are
placeholders.** An Alertmanager with no receiver accepts every alert and drops
it silently, which is the worst state to be in because the rules show as
loaded. Until a test alert has reached somebody's phone, this is a
well-reasoned configuration file and not monitoring.

**2. No backup is scheduled.** The procedure is proven and nothing runs it. No
nightly dump, no WAL archiving, no offsite copy, and no calendar entry for the
monthly restore test. Every organisation that has lost data had backups.

**3. Evidence storage is a mock.** The largest concentration of personal data
in the system — photographs of doorways and occasionally people — sits behind
an adapter that has never written to a bucket. The retention job calls
`delete` on the port and no real object has ever received it.

**4. Payments are a mock.** The bookkeeping is correct and no money has moved.

**5. Escalations reach nobody.** The dispatch sweep's safety valve — three
rounds, then hand it to a human — logs to a null recipient, because there is no
on-call address in the system. Alert on
`rescue_dispatch_sweep_actions_total{action="escalated"}` in the meantime.

**6. `PrismaStore` has still never executed, anywhere.** Not a lack of trying:
`binaries.prisma.sh` is refused by the proxy in both environments available
here, the `@prisma/engines` npm package is 23 KB of postinstall script rather
than the binary, and the only engine in reach is a macOS one that a Linux
container cannot load. So the schema layer is now verified in depth and the
adapter that talks to it is verified not at all — the 37 checks prove the SQL
is right, not that Prisma emits it. `pnpm test:db` closes this on any machine
with Docker, and the CI database job closes it on every pull request, which is
the real fix because it stops depending on anyone remembering.

**7. No load test.** None of the numbers in the incident runbook have a known
normal, so "climbing" is a judgement call.

**8. No Article 15 export.** Compliance can read the data through the console;
there is no one-click subject access export, so a request is met by hand.

**9. Actions on mutable tags.** `actions/checkout@v4` is whatever that tag
points at today. Pin them:

```
gh api repos/actions/checkout/git/ref/tags/v4 --jq .object.sha
```

and replace `@v4` with `@<sha> # v4` for each. Not done here because the
container's egress cannot reach the GitHub API, and a fabricated digest is
worse than a tag.

**10. No DPA with Nominatim or OSRM.** They receive postal codes and are
volunteer-run public services. Self-host or contract.

**11. Rate limiting is in-process.** Two API instances mean twice the limit.

**12. No down migrations.** Every migration so far is additive, so an older
image runs against a newer schema and rollback is an image change. The first
migration that drops or renames a column ends that, and needs a two-step plan.

## 5. Before the pilot

1. Point a Prometheus at `/metrics` and alert on four series:
   `outbox_oldest_pending_seconds`, `outbox_messages{status="DEAD"}`,
   `dispatch_sweep_runs_total{outcome="error"}` and
   `dispatch_sweep_actions_total{action="escalated"}`.
2. Schedule the nightly dump and put the monthly restore test in a calendar.
3. Give escalations a real recipient.
4. Set `METRICS_TOKEN`, `OIDC_ISSUER`, `OIDC_JWKS_URI`, `REGISTRATION_HASH_KEY`
   and `DATABASE_URL`. The config refuses to boot in production without most of
   them, which is deliberate.
5. Run `pnpm test:db` once on a machine with Docker, so `PrismaStore` has
   executed somewhere before it executes in Bremen.

None of these is a code change.

## 6. Where to look

| | |
| --- | --- |
| Foundation audit | `docs/audits/FOUNDATION_AUDIT.md` |
| Backend | `docs/audits/PHASE_2_BACKEND.md` |
| Frontend | `docs/audits/PHASE_3_FRONTEND.md` |
| Platform | `docs/audits/PHASE_4_PLATFORM.md` |
| Data inventory | `docs/audits/DATA_INVENTORY.md` |
| Threat model | `docs/audits/THREAT_MODEL.md` |
| Backup and restore | `docs/runbooks/BACKUP_AND_RESTORE.md` |
| Incidents | `docs/runbooks/INCIDENTS.md` |
| Fallback decision | `docs/adr/0001-fallback-returns-to-quoted.md` |
