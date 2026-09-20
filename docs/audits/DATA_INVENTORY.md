# Data inventory and retention

**Branch:** `claude/phase-3-frontend`
**Date:** 2026-09-19
**Status:** the engineering half of a record of processing activities. The
legal half — controller and processor roles, the DPA with each provider, the
transfer basis for any non-EU sub-processor — is not here and is not something
a code base can assert.

The machine-readable version is `apps/api/src/lib/privacy.ts`, and a test holds
it against `schema.prisma`: a table added without a classification fails the
build, and a classification naming a field that does not exist fails too. This
document is the reasoning; that file is the record.

## 1. Why this is code and not a spreadsheet

Every ROPA that has ever been written in a spreadsheet was accurate on the day
it was written. The schema then moved and the spreadsheet did not, and the gap
is invisible until a supervisory authority asks a question the document answers
wrongly.

So the inventory is a typed constant, the table names are checked against the
schema, and `/v1/privacy/inventory` serves it to compliance. It cannot describe
a table that does not exist.

## 2. What is stored, and on what basis

| Table | Personal data | Basis | Retention | On erasure |
| --- | --- | --- | --- | --- |
| User | subject, email, name | contract | lifecycle | **redact** |
| Membership | — | contract | lifecycle | already pseudonymous |
| Organization | — (sole traders aside) | contract | 10y | retained by law |
| Provider | legalName, contactEmail | contract | 10y | retained by law |
| Vehicle | registrationHash | contract | lifecycle | already pseudonymous |
| ProviderDocument | storageKey | legal obligation | 6y | retained by law |
| Job | pickup, destination, notes, customerReference | contract | 6y | **redact** |
| Quote | — | legal obligation | 10y | retained by law |
| AssignmentOffer | — | contract | 6y | already pseudonymous |
| Assignment | — | legal obligation | 10y | retained by law |
| Evidence | storageKey, uploadedByUserId | contract | **1y** | **delete** |
| IdempotencyKey | responseBody | legitimate interest | **7d** | **delete** |
| JobEvent | — | legal obligation | 6y | retained by law |
| AuditLog | — | legal obligation | 6y | retained by law |
| OutboxMessage | payload | contract | **30d** | **delete** |
| LedgerEntry | — | legal obligation | 10y | retained by law |
| Suggestion | output | legitimate interest | 6y | retained by law |

Ten years is §147 AO, for anything feeding a tax return. Six is §257 HGB, for
commercial correspondence. Both are longer than a data subject would like and
both override an erasure request under Article 17(3)(b) — which is why the
design question is not "can we delete this" but "can we stop it naming anyone".

## 3. The structural decision

**One table holds a name.**

`User` has the name, the email and the identity-provider subject. Nothing else
does. Every other record that involves a person holds an id.

That is what makes erasure a single operation instead of a migration. Redact
three columns on one row and every `actorId` in `JobEvent`, every
`uploadedByUserId` on `Evidence`, every `approvedByUserId` on `Quote` stops
resolving to a person — while the rows themselves, which the tax authority may
want, stay exactly as they were.

The corollary is a rule with a test behind it: **an event payload never carries
an address or a name.** `JobEvent` and `AuditLog` are append-only in PostgreSQL
by trigger, so a personal detail written into one could not be taken out again
without dropping the trigger that makes the audit log an audit log.
`privacy.test.ts` creates a job and asserts that none of the four personal
fields on it appear anywhere in the event stream.

## 4. Erasure

`POST /v1/privacy/erasure`, compliance or admin only, with a mandatory reason.

What it does:

- `User.name` → `Gelöschte Person`
- `User.email` → `erased-<id>@erased.invalid` (RFC 2606; can never be delivered to)
- `User.subject` → `erased:<id>` — a value no identity provider can issue, so
  the same person signing in again becomes a new person rather than reviving
  this record
- `Evidence.uploadedByUserId` → null
- an `AuditLog` row recording that it happened, the count of rows touched, and
  **not** the values removed

What it deliberately does not do:

- touch the jobs. A pickup address belongs to the ordering organisation, not to
  the individual who typed it; an employee's erasure request does not reach
  their employer's records. The organisation's does, and that is a different
  operation with a different authority behind it.
- delete anything under Article 17(3)(b).

It is idempotent and says so: erasing an already-erased user returns
`erased: false` rather than reporting work it did not do. The endpoint answers
200 either way — a 404 would confirm that a given user id once existed.

## 5. Retention

Runs daily in the worker process, not as a cron job someone installs. Storage
limitation is the principle a system breaches by doing nothing, so the
enforcement has to be part of the thing that runs.

Three categories:

- **Evidence, one year.** The largest concentration of personal data in the
  system — photographs of doorways, hallways, occasionally people, and
  signatures. Its purpose is proving the job was done, and that purpose expires
  with the window for disputing it.
- **Delivered outbox rows, thirty days.** Long enough to investigate a
  complaint about a message; short enough that the queue is not an archive.
  **Dead letters are exempt.** They are work that never happened, and a queue
  that tidies away its own failures cannot be audited.
- **Idempotency records, seven days.** A stored response body is a copy of
  whatever the endpoint returned, which for a job read is an address. It exists
  to make a retry safe, and retries do not arrive a week later.

The order matters. The row is deleted first and the storage object second,
because the reverse leaves a row pointing at nothing — served to a user as a
broken photograph. This way a crash leaves an object with no row, which is a
leak, so every storage failure is returned in `orphanedObjects`, logged at
error, and named for manual removal rather than swallowed.

## 6. Logs

Logs are the least access-controlled store in most deployments: shipped to a
third party, kept longer than the database, readable by people who would never
be granted a row in `Job`. An unredacted log is therefore a second copy of
personal data with a different retention period and a different set of readers.

Redaction is configured on the logger, not applied at call sites, because a
call site can be forgotten. `apps/api/src/lib/redaction.ts` lists every path;
`observability.test.ts` drives real requests through the real app logger into a
captured stream and asserts each one is gone — a test that builds its own pino
with the same options would prove only that pino works.

Credentials never appear. Addresses, contacts and vehicle registrations are
removed from the automatic request and response logs. Correlation ids, job ids
and statuses survive, or the log would be useless.

## 7. What is still open

- **No data-subject access export.** Article 15 requires a copy on request.
  Compliance can read the data through the console, but there is no
  one-click export, so a request is met by hand today.
- **No consent record**, because nothing here is processed on consent. If
  marketing is ever added, that changes and this document changes with it.
- **Retention periods are defaults, not determinations.** Ten years for tax and
  six for commercial records are the statutory floors; one year for evidence and
  thirty days for delivered messages are engineering judgements that a
  controller has to accept or change. They are configuration
  (`RETENTION_*_DAYS`) for that reason.
- **The processor chain is undocumented.** Nominatim and OSRM receive postal
  codes — arguably personal data in a small enough postcode — and both are
  third parties with no DPA in place. Either self-host them or sign something.
- **Evidence objects live in the mock storage adapter.** The retention job
  calls `delete` on the port; no real bucket has ever received that call.
