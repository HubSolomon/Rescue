# Backup and restore

**Executed, not written.** Every command below was run against PostgreSQL 16.13
on 2026-09-19, against a database with all five migrations applied and rows in
`Job`, `JobEvent`, `LedgerEntry`, `OutboxMessage`, `User` and `Organization`.
The findings in §5 came out of doing it.

## 1. Taking a backup

```bash
pg_dump --format=custom --compress=9 --file=rescue-$(date +%Y%m%dT%H%M%SZ).dump "$DATABASE_URL"
sha256sum rescue-*.dump > rescue-*.dump.sha256
```

Custom format, not plain SQL. It is the only format `pg_restore` can restore
selectively — one table, or data without schema — and during an incident the
difference between "restore the ledger" and "restore everything" is the
difference between ten minutes and an outage.

The checksum is not optional. A backup nobody has verified is a belief.

## 2. Restoring into an empty database

The realistic case: the database is gone, or is being rebuilt somewhere else.

```bash
createdb rescue_restored
pg_restore --dbname=rescue_restored --no-owner --no-privileges rescue-<stamp>.dump
```

`--no-owner --no-privileges` because the roles on the new server are rarely
the roles on the old one, and a restore that fails two thirds of the way
through on a `GRANT` leaves a half-populated database that looks fine.

**Verified:** 17 tables, all 4 append-only triggers present and armed, ledger
amounts exact to the cent. The drill restored in under a second on an 8 MB
database; scale that with your own data before quoting an RTO.

Then check, before pointing anything at it:

```sql
SELECT count(*) FROM pg_tables WHERE schemaname = 'public';           -- expect 17
SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal;               -- expect 8
SELECT sum("amountCents") FROM "LedgerEntry";                         -- compare to the last known figure
SELECT max("createdAt") FROM "JobEvent";                              -- how far back you have gone
```

The last one is the number to give people. "We lost everything after 14:05" is
an answer; "we restored the backup" is not.

## 3. Restoring data into a database that still has its schema

Rarer, and more dangerous, because the append-only triggers will refuse the
insert of rows that already exist and refuse the delete of rows that should
not.

```bash
pg_restore --dbname="$TARGET" --data-only --disable-triggers rescue-<stamp>.dump
```

`--disable-triggers` **requires superuser**. If the restore runs as the
application role it will fail on the first append-only table, and the error
will name the trigger rather than the permission. Budget for that.

This path leaves duplicate-key errors on any row that survived. They are
reported and skipped, and `pg_restore` still exits non-zero — read the output
rather than the exit code alone. In the drill, `User` had survived a cascade
and produced exactly that error while everything else restored correctly.

## 4. What is not in the dump

- **Evidence objects.** Photographs and signatures live in object storage, not
  in PostgreSQL. A restored database has rows pointing at objects that a bucket
  restore has to match. If the two are taken at different times, the mismatch
  shows up as broken photographs on completed jobs, and no error anywhere.
  Take them together or accept the gap knowingly.
- **Secrets.** `JWT_SECRET`, `REGISTRATION_HASH_KEY`, `METRICS_TOKEN`. Losing
  `REGISTRATION_HASH_KEY` makes every stored vehicle-registration hash
  permanently unmatchable — the data is still there and no longer means
  anything.
- **The outbox's in-flight state**, in the sense that matters: a message
  claimed but not delivered at dump time comes back claimable, and its
  side effect runs again. That is correct — delivery is at-least-once and
  every handler is written to survive a repeat — but it means a restore can
  re-send notifications from the covered period. Tell the team before you do it.

## 5. What the drill found

**Append-only did not survive `TRUNCATE`.**

The guards on `JobEvent`, `AuditLog`, `LedgerEntry` and `Suggestion` were
row-level `BEFORE UPDATE OR DELETE` triggers. PostgreSQL does not fire
row-level triggers for `TRUNCATE` — there are no rows, only a file being
replaced. So the tables the system treats as immutable could be emptied by a
single statement, and the audit log would not record it, because the audit log
is one of the tables.

`UPDATE` and `DELETE` were correctly refused. `TRUNCATE "JobEvent"` succeeded
and returned zero rows.

Migration `20260919000400_truncate_guard` adds statement-level `BEFORE
TRUNCATE` triggers. Verified after applying it: a direct `TRUNCATE "JobEvent"`
is refused, and `TRUNCATE "Job" CASCADE` — which would have taken the events,
the ledger and the suggestions with it — is refused by the children's guards
and rolls back entirely, leaving all three tables intact.

This was not found by reading the code. It was found by trying to destroy the
data and noticing it worked.

## 6. Schedule, and the part that is missing

| | |
| --- | --- |
| Frequency | nightly full dump; continuous WAL archiving for point-in-time recovery |
| Retention | 30 daily, 12 monthly — the monthlies are what a tax audit asks for |
| Location | a different account from the database, with write-once retention |
| Encryption | at rest; the dump contains every address in the system |
| **Restore test** | **monthly, into a scratch database, with §2's checks run** |

The last row is the only one that matters. Every organisation that has lost
data had backups.

**Not yet configured:** none of this schedule exists. There is no nightly job,
no WAL archiving, no offsite copy and no calendar entry for the monthly
restore. What exists is a procedure that has been executed once, by hand, and
the knowledge that it works.
