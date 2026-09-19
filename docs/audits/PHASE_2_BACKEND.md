# Phase 2 — Backend foundation

**Branch:** `claude/phase-2-backend`
**Date:** 2026-09-19
**Baseline:** `e7047db` (audit + configuration hardening merged to main)

## 1. Architecture changes

**Authentication is an abstraction with two implementations.** `TokenVerifier`
is satisfied by `OidcTokenVerifier` (JWKS, signature/issuer/audience/expiry) and
`DevTokenVerifier` (HS256, development only). `buildVerifier` throws rather than
falling back to the symmetric verifier when `NODE_ENV=production`, so a
misconfigured deployment fails to boot instead of quietly accepting self-signed
tokens.

**Authorisation reads only from the database.** A new `Membership` model links a
user to exactly one tenant — a customer organisation, a provider, or neither
(RESCUE staff), enforced by a CHECK constraint. `X-Organization-Id` and
`X-Provider-Id` select among memberships the caller already holds; they cannot
introduce one.

**Persistence is a port with two adapters.** `Store` is the interface;
`MemoryStore` and `PrismaStore` implement it. Every read that can reach a
customer record takes a `Scope` — there is no overload without one — so
forgetting to filter by tenant is a compile error. Operations that must be
atomic (`transitionJob`, `acceptOffer`, `decideQuote`) are single methods, so no
call site can write half a transaction.

**The job state machine moved.** Provider fallback now returns a job to `QUOTED`
rather than `TRIAGED`, and `QUOTED` is the only state from which `ASSIGNED` is
reachable. Recorded in `docs/adr/0001-fallback-returns-to-quoted.md`;
`docs/ARCHITECTURE.md` is updated to match.

**Contracts are split by domain** (`common`, `money`, `auth`, `job`, `provider`,
`commerce`) and the OpenAPI document is generated from them, so it cannot drift.

## 2. Security findings fixed, and still open

### Closed, each with a regression test

| Finding | What changed | Test |
| --- | --- | --- |
| **C1** No authentication | Global `onRequest` hook; exemptions are an explicit allow-list | `regressions.test.ts` — six routes answer 401; forged and unknown-subject tokens rejected |
| **C2** Client-supplied tenancy | `organizationId` removed from `createJobSchema`; taken from the principal | An `organizationId` in the body is ignored; a foreign `X-Organization-Id` is 403 |
| **C3** Unparameterised list dumps all tenants | `listJobs` requires a `Scope`; no organisation parameter exists | Cross-tenant list returns only the caller's jobs; `?organizationId=` is inert |
| **C4** No ownership check on job detail | Tenant predicate is in the query; cross-tenant reads answer 404, not 403 | Foreign fetch returns 404 and leaks neither address nor notes |
| **H4** No idempotency | `Idempotency-Key` required on mutations; body hashed; replay returns the stored response | Duplicate create yields one job; changed body on the same key is 409; keys are per-organisation |
| **H5** Audit log never written | Every mutation writes `JobEvent` + `AuditLog` in the same transaction; both tables are append-only via database triggers | Event sequence asserted end to end; a failed transition writes no event |
| **M2** No persistence | `PrismaStore` implemented; selected by `DATABASE_URL` | Conformance suite (see §5) |
| **M3** Unbounded list | Cursor pagination, default 25, max 100 | Pages 7 records in 3s with no repeats or drops |
| **M4** No migrations | Two migrations committed and applied against PostgreSQL 16 | Verified by execution (§5) |
| **M6** Prisma client built at import | Replaced with lazy `getDb()` | — |
| **M9** Almost no tests | 157 passing | — |
| **H7** Unpatched advisories | `postcss` and `deepmerge-ts` pinned to patched versions; `pnpm audit --audit-level=high` added to CI | CI |
| **L1/L2** Stale `sharp` entry, duplicated build lists | `pnpm-workspace.yaml` cleaned | — |
| **L3** Zod internals echoed to clients | Field path and message only | `app.test.ts` asserts the rejected value is not returned |
| **L4** Opaque non-JSON errors | Content type checked before parsing | — |
| **L5** No readiness probe | `/v1/ready` checks the store; `/v1/health` stays dependency-free | — |

Also closed: `pnpm lint` added to CI (it was defined but never run, which is
why the M1 build-ordering defect reached `main`).

### Open

- **M7 CSRF.** Still unresolved, and now more pressing. The API uses bearer
  tokens, so `credentials: true` on CORS should become `false` when the web app
  adopts them in Phase 3. Decide before cookies are introduced, not after.
- **M8 No real linting.** `lint` is still `tsc --noEmit`. No ESLint, no
  `eslint-plugin-security`, no `eslint-config-next`.
- **M10 docker-compose** still binds Postgres, Redis and MinIO to all
  interfaces with static credentials, and `minio/minio:latest` is unpinned.
- **M11** Payments, notifications and the outbox are Phase 4.
- **L6 Dashboard** still renders a hardcoded array; **L7** no i18n. Phase 3.
- **Evidence uploads are not scanned.** MIME type and size are allow-listed and
  the storage key is server-generated, but there is no malware scan and no EXIF
  stripping. Both are Phase 4, and until then the bucket should not be public.
- **Expiry sweep is manual.** `POST /v1/offers/expire` is admin-triggered; it
  needs a worker on a timer (Phase 4).
- **Distance is a postal-code approximation**, not road distance. It biases
  toward excluding providers, so it is safe but crude, and must not be shown to
  customers as a real distance. Replaced by the maps adapter in Phase 4.

## 3. Database migrations

Two, both applied cleanly against PostgreSQL 16 during this work:

- `20260919000000_init` — 14 tables, enums, indexes, foreign keys. Monetary
  columns are `INTEGER` cents; there is no `DOUBLE PRECISION` anywhere.
- `20260919000100_append_only_audit` — revokes `UPDATE`/`DELETE` on `JobEvent`
  and `AuditLog` from the application role and installs triggers that reject
  those operations for everyone but the owner. A no-op when the role does not
  exist, so local and CI runs are unaffected.

Database-level invariants, all verified by execution:

| Invariant | Mechanism |
| --- | --- |
| Audit log cannot be altered | `BEFORE UPDATE OR DELETE` trigger raises `insufficient_privilege` |
| One active assignment per job | `CREATE UNIQUE INDEX ... WHERE status = 'ACTIVE'` |
| `grossCents = netCents + vatCents` | CHECK constraint |
| No negative money | CHECK constraints on quotes, offers, assignments |
| A membership is org **or** provider, never both | CHECK constraint |

## 4. API and functionality added

27 documented paths at `/v1/openapi.json`, generated from the Zod contracts.

- **Auth** — `POST /auth/dev-token` (non-production only), `GET /auth/me`
- **Jobs** — create, list (paginated, tenant-scoped), fetch, event timeline,
  dispatcher triage approval, start, complete, cancel
- **Quotes** — create (dispatcher; VAT computed server-side in integer cents),
  list, customer decision (CUSTOMER_ADMIN only)
- **Dispatch** — ranked eligible providers with reasons for every exclusion,
  offer fan-out, offer list, fallback, expiry sweep
- **Provider** — own offers, accept/decline
- **Providers** — onboarding, compliance review, vehicles (registration stored
  only as a keyed hash), documents, document review
- **Evidence** — signed upload ticket, completion, listing
- **Ops** — `/health`, `/ready`, `/openapi.json`

## 5. Test and build results

`pnpm check` passes: typecheck, lint, 157 tests, build.

| Suite | Tests | Covers |
| --- | --- | --- |
| `regressions` | 21 | C1–C4 and role gates |
| `eligibility` | 23 | every exclusion reason, ranking determinism, distance |
| `evidence` | 19 | MIME allow-list, size caps, path traversal, access control |
| `hardening` | 19 | secrets, production boot guards, rate limiting |
| `store-memory` | 15 | the shared store conformance suite |
| `dispatch` | 14 | eligibility gating, the accept race, expiry, fallback |
| `money` | 12 | integer arithmetic, half-up VAT rounding |
| `workflow` | 10 | full lifecycle, invalid transitions, audit trail |
| `app` | 9 | envelopes, correlation ids, error shapes |
| `openapi` | 8 | document generation and route coverage |
| `idempotency` | 7 | replay, body mismatch, tenant scoping, TTL |
| `store-prisma` | skipped | same conformance suite, needs `DATABASE_URL` |

Two bugs were found by these tests rather than by review:

1. **The state machine contradicted itself.** Two providers accepting
   concurrently both received 409 because the job sat in `TRIAGED` and
   `TRIAGED -> ASSIGNED` is not a legal edge, while the offer route allowed
   fan-out from `TRIAGED`. Fixed via ADR 0001.
2. **The web form would not compile** once `organizationId` left the contract —
   the frontend had been sending it. Removed.

### What was NOT executed

**`PrismaStore` has never been run.** The sandbox could not reach
`binaries.prisma.sh`, so no Prisma query engine was available and not one line
of that file executed. It typechecks against the generated client — column
names, enum values and relation names are therefore verified — and the SQL
semantics it depends on (the partial unique index, the CHECK constraints, the
append-only triggers) were each exercised directly with `psql` against
PostgreSQL 16. But the adapter itself is unproven.

Before trusting it, run the conformance suite against a real database:

```bash
createdb rescue_test
DATABASE_URL=postgresql://localhost:5432/rescue_test pnpm db:deploy
DATABASE_URL=postgresql://localhost:5432/rescue_test pnpm --filter @rescue/api test
```

That runs the same 15 behaviours `MemoryStore` already passes. Treat a green
run as the point at which `PrismaStore` becomes trustworthy — not this
document.

## 6. Commits

One commit on `claude/phase-2-backend`. Files: 33 added or changed across
contracts, database, API and web, plus the ADR and this report.

## 7. Environment variables still required

For production, all of these, or the service refuses to start:

| Variable | Why |
| --- | --- |
| `OIDC_ISSUER`, `OIDC_JWKS_URI` | Real identity provider; the dev issuer is unavailable in production |
| `DATABASE_URL` | The in-memory store loses data on restart |
| `REGISTRATION_HASH_KEY` | Keys the vehicle-plate hash; changing it orphans existing hashes |
| `STORAGE_PROVIDER=s3` plus `S3_*` | `mock` signs URLs but stores nothing |
| `WEB_ORIGIN` | Exact origin; a wildcard is rejected |
| `TRUST_PROXY_HOPS` | Set to the number of proxies you actually run |

`JWT_SECRET` is needed only where the development issuer is in use.

## 8. Before production

1. **Run the Prisma conformance suite** against a real database (§5). Nothing
   else on this list matters until the persistence layer is proven.
2. **Choose and configure an identity provider**, and create the first `ADMIN`
   and `COMPLIANCE` users. There is no bootstrap path yet — the seed only
   applies to the in-memory store, so the first production users must be
   inserted by hand or by a migration you write.
3. **Create the restricted database role** the append-only migration expects,
   and run the application as it rather than as the owner. Without that step
   the triggers are the only protection on the audit tables.
4. **Decide the CSRF posture** before Phase 3 adds sessions (M7).
5. **Add malware scanning and EXIF stripping** to the evidence path, and keep
   the bucket private.
6. **Replace the postal-code distance estimate** with the maps adapter before
   quoting on distance or showing a distance to anyone.
7. **Schedule the offer expiry sweep**; today it only runs when an admin calls
   it, so a job can sit on a dead offer indefinitely.
8. **Add ESLint** (M8) and lock down `docker-compose` (M10).

Critical and High findings from the foundation audit are closed. That is not
the same as production-ready: item 1 above is a genuine blocker, and items 2
and 3 mean the security guarantees are not yet fully in force in a deployed
environment.
