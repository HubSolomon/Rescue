# RESCUE Foundation Audit

**Scope:** `rescue-circular-logistics` at commit `a890f65` (scaffold, pre-implementation)
**Date:** 2026-09-19
**Phase:** 1 — audit only. No application code was modified.

## Verdict

The scaffold builds, typechecks and passes its three tests. It is **not** safe to expose to any network, including a shared office LAN. The API has no authentication, no authorisation and no tenant isolation of any kind; every job record — pickup address, customer reference and free-text notes — is readable by any unauthenticated caller. Four Critical findings below are reproduced with working proof-of-concept requests, not inferred from reading code.

The architecture documentation is sound and the Prisma schema is a reasonable foundation. The gap is that almost none of the documented trust boundaries are enforced by code. `docs/ARCHITECTURE.md` states "Never trust browser-supplied organisation IDs"; the shipped contract requires the browser to supply one.

## Baseline check results

Run from a clean clone with `pnpm@11.19.0`, Node 22.

| Command | Result | Notes |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | pass | 171 packages, lockfile in sync |
| `pnpm db:generate` | **fail (environment)** | needs egress to `binaries.prisma.sh`; see M5 |
| `pnpm lint` | **fail** | 6 TypeScript errors from a clean clone; see M1 |
| `pnpm typecheck` | pass | |
| `pnpm test` | pass | 3 tests, all in `apps/api`; see M11 |
| `pnpm build` | pass | api `tsc`, web Next.js 6 static routes |
| `pnpm audit` | **3 high, 4 moderate** | see H7 |
| `pnpm check` | **fail** | blocked at its first step, `lint` |

`pnpm check` is the verification command named in `README.md`. It does not currently pass on a fresh checkout.

---

## Critical

### C1 — Every API endpoint is unauthenticated

**File:** `apps/api/src/app.ts`, `apps/api/src/routes/jobs.ts`

**Evidence:** No authentication plugin is registered in `buildApp`. No route declares a `preHandler`, `onRequest` hook or any credential check. `config.ts` defines a `JWT_SECRET` that nothing reads.

Proof — a request with no headers at all:

```
POST /v1/jobs   (no Authorization, no cookie, no API key)
-> 201 Created
```

**Failure scenario:** Anyone who can reach the API creates, reads and enumerates logistics jobs for every customer. On a pilot deployment this is a full data breach of customer names, business addresses and access instructions on day one.

**Remediation:** Register an authentication decorator before the route plugins and fail closed.

1. Add an `authenticate` `onRequest` hook in a Fastify plugin that verifies an OIDC access token (or, for the test identity provider, a signed JWT using `config.JWT_SECRET`) and populates `request.user = { sub, organizationId, roles }`.
2. Register it globally in `buildApp` via `app.addHook("onRequest", authenticate)`, then allow-list `/v1/health` explicitly rather than opting routes in one at a time.
3. Refuse to boot in production when no identity provider is configured — a missing IdP must be a startup error, not a silent open door.
4. Add a test asserting `401` for every `/v1/jobs*` route without credentials.

### C2 — Tenant identity is supplied by the client

**Files:** `packages/contracts/src/index.ts:31` (`createJobSchema.organizationId`), `apps/web/components/request-form.tsx:9` (`defaultOrg`), `apps/api/src/lib/job-store.ts:15`

**Evidence:** `createJobSchema` requires `organizationId: z.string().uuid()` in the request body. The web form carries it as a `defaultValues` entry inside React Hook Form state, i.e. editable client state. `InMemoryJobStore.create` writes `{ ...input }` straight through, so whatever UUID the caller sends becomes the record's owner.

This directly contradicts `docs/ARCHITECTURE.md` § Trust boundaries: *"Never trust browser-supplied organisation IDs."*

**Failure scenario:** A customer edits one field in DevTools (or curl) and writes records into a competitor's tenant, or attributes their own costs to another organisation. Once billing is attached to `organizationId`, this is a financial-integrity defect, not just a data one.

**Remediation:**

1. Remove `organizationId` from `createJobSchema`. Split the contract: `createJobSchema` is the client-facing input; a server-side `jobRecordSchema` adds `organizationId` from `request.user.organizationId`.
2. In `POST /v1/jobs`, call `jobStore.create({ ...parsed, organizationId: request.user.organizationId })`.
3. Delete `defaultOrg` from `request-form.tsx` and drop the field from the form entirely.
4. Add a test that posts an `organizationId` in the body and asserts the stored record ignores it.

### C3 — `GET /v1/jobs` with no parameters returns every tenant's jobs

**File:** `apps/api/src/lib/job-store.ts:18-20`

**Evidence:** `list(organizationId?)` filters with `!organizationId || job.organizationId === organizationId`. When the parameter is absent the predicate is always true.

Proof — two jobs created under different organisations, then one unauthenticated request:

```
GET /v1/jobs        (no query string)
-> refs from all tenants: [ 'B-SECRET', 'A-SECRET' ]
```

**Failure scenario:** A single unauthenticated `GET /v1/jobs` dumps the entire platform: every customer's addresses, references and notes. No enumeration or guessing required.

**Remediation:** Make the tenant a required, non-optional argument.

1. Change the interface to `list(organizationId: string): Promise<Job[]>` — no default, no optional marker, so omitting it becomes a compile error.
2. Pass `request.user.organizationId`; never read `organizationId` from `request.query`.
3. For dispatcher/admin cross-tenant views, add a separate explicitly-named method (`listAllForDispatcher`) guarded by a role check, so cross-tenant access is always a deliberate call site.

### C4 — `GET /v1/jobs/:id` performs no ownership check

**File:** `apps/api/src/routes/jobs.ts:15-20`

**Evidence:** The handler fetches by id and returns it. There is no comparison between the job's `organizationId` and any caller identity — there is no caller identity to compare against.

Proof — a job created under org A, fetched with no credentials:

```
GET /v1/jobs/<uuid>
-> 200, pickup.line1: "Am Markt 1"
-> 200, notes: "Gate code 4471. Contact Frau Muller 0151-2233445."
```

**Failure scenario:** Job IDs are UUIDv4 so they are not guessable at scale, but they leak — in URLs, emails, provider notifications, support tickets and browser history. Any leaked ID yields the full record, including building access codes and a named individual's mobile number. That is special-category operational data and personal data under GDPR Art. 4.

**Remediation:**

1. After fetching, `if (job.organizationId !== request.user.organizationId) throw new AppError(404, "JOB_NOT_FOUND", "Job not found")` — return 404, not 403, so the endpoint does not confirm that an ID exists in another tenant.
2. Better, push the check into the store: `get(id, organizationId)` so no call site can forget it.
3. Add a test asserting org B receives 404 for org A's job ID.

---

## High

### H1 — Rate limiting is bypassable by spoofing `X-Forwarded-For`

**File:** `apps/api/src/app.ts:12` (`trustProxy: true`), `:15` (`rateLimit`)

**Evidence:** `trustProxy: true` tells Fastify to trust `X-Forwarded-For` from **any** peer. `@fastify/rate-limit` keys buckets on `request.ip`, which is derived from that header. So the client chooses its own rate-limit bucket.

Proof — 140 requests against a live server:

```
140 requests, rotating X-Forwarded-For -> { "200": 140 }   (0 throttled)
```

**Failure scenario:** The 100 req/min limit is decorative. Any scripted client bypasses it with one rotating header, enabling brute force and scraping of the endpoints in C3/C4 at full speed.

**Remediation:** Replace `trustProxy: true` with the number of proxy hops you actually run behind, or an explicit allow-list — `trustProxy: 1`, or `trustProxy: ["10.0.0.0/8"]` for your load balancer's subnet. Make it configurable (`TRUSTED_PROXY_HOPS`) and default it to `false` so a misconfigured deployment fails closed. Once authentication exists, key the rate limiter on the authenticated subject rather than the IP.

### H2 — Throttled requests return HTTP 500, not 429

**File:** `apps/api/src/app.ts:17-22`

**Evidence:** The custom `setErrorHandler` matches `ZodError` and `AppError`, then falls through to `app.log.error(error)` + a 500 `INTERNAL_ERROR`. The error thrown by `@fastify/rate-limit` is neither type, so it takes the fallback branch.

Proof — 140 requests from one IP:

```
{ "200": 100, "500": 40 }     expected: { "200": 100, "429": 40 }
```

**Failure scenario:** Three separate problems. Clients cannot distinguish "slow down" from "the server is broken" and will retry immediately, amplifying load. The `Retry-After` header is discarded. And every throttled request is written at `error` level, so an attacker turns a rate limit into log-volume amplification and drowns real incidents — while your 5xx alerting fires on what is actually correct behaviour.

**Remediation:**

1. Add a branch before the fallback: `if (error.statusCode === 429) return reply.code(429).send({ error: { code: "RATE_LIMITED", message: "Too many requests" } })`, preserving headers already set by the plugin.
2. More generally, handle any error carrying a 4xx `statusCode` as a client error at `warn` level, and reserve `log.error` + 500 for genuinely unexpected failures.
3. Add a test asserting the 101st request returns 429 with the documented error envelope.

### H3 — Production-capable default for `JWT_SECRET`

**File:** `apps/api/src/config.ts:8`

**Evidence:** `JWT_SECRET: z.string().min(32).default("development-only-secret-change-me-now")`. The default is 41 characters, so it satisfies `min(32)` and validation passes with the variable unset — in any `NODE_ENV`, production included. The `.env.example` placeholder `replace-with-at-least-32-random-characters` is 42 characters and also passes.

**Failure scenario:** The secret is in a public commit. Once tokens are issued with it, anyone can forge a token for any user and any organisation — which collapses every control added for C1–C4.

**Remediation:**

1. Remove the default. Make the field `z.string().min(32)` and required.
2. Add a refinement that rejects known placeholder values outright, so `.env.example` cannot be copied into production unchanged.
3. Fail fast: `configSchema.parse` already throws at import; keep it that way and let the process exit rather than booting degraded.
4. Add a startup assertion that `NODE_ENV === "production"` implies the secret was read from the environment.

### H4 — No idempotency on mutations

**File:** `apps/api/src/routes/jobs.ts:6-11`

**Evidence:** `POST /v1/jobs` reads no `Idempotency-Key` header and has no replay store. `docs/ARCHITECTURE.md` § API conventions requires one: *"Mutation requests require an idempotency key before payment and dispatch integrations are enabled."*

**Failure scenario:** A retry on a flaky mobile connection creates duplicate jobs. Once dispatch and payment are wired, a duplicate is a duplicate van dispatched and a duplicate authorisation against the customer's card.

**Remediation:** Require an `Idempotency-Key` header on all mutating routes. Store `(organizationId, key)` with the request-body hash and serialised response, in the same transaction as the mutation. On replay with a matching hash, return the stored response; on a mismatched hash, return 409. Set a 24-hour retention window.

### H5 — Nothing is ever written to the audit log

**Files:** `packages/database/prisma/schema.prisma` (`AuditLog`, `JobEvent`), `apps/api/src/routes/jobs.ts`

**Evidence:** Both models exist in the schema. Neither is referenced anywhere in `apps/` — `grep -rn "@rescue/database" apps/` returns nothing. Job creation writes one in-memory record and no event.

**Failure scenario:** The architecture requires that *"Every status, payout, compliance and manual-override change must create an immutable audit event."* With no audit trail there is no way to reconstruct who approved a hazardous-material exception, who overrode provider eligibility, or what a job looked like before a disputed change. That is both a GDPR accountability failure (Art. 5(2)) and an evidentiary failure in any customer claim.

**Remediation:** Write the domain mutation and its `JobEvent` + `AuditLog` rows inside one `prisma.$transaction`, so an audit write cannot be skipped or fail independently. Record actor, action, entity type/id, before/after diff and correlation ID. Grant the application role `INSERT` but not `UPDATE`/`DELETE` on both tables at the database level, so immutability is enforced by Postgres rather than by convention.

### H6 — Unauthenticated API binds to all interfaces

**File:** `apps/api/src/server.ts:5`

**Evidence:** `app.listen({ port: config.API_PORT, host: "0.0.0.0" })` — hardcoded, not configurable.

**Failure scenario:** A developer running `pnpm dev` on café or office Wi-Fi exposes the entire unauthenticated API (C1–C4) to everyone on that network. `0.0.0.0` is correct inside a container but wrong as a development default.

**Remediation:** Add `API_HOST` to the config schema, default it to `127.0.0.1`, and set `0.0.0.0` only in the container image's environment.

### H7 — Seven known vulnerabilities in the dependency tree, and CI never checks

**Files:** `pnpm-lock.yaml`, `.github/workflows/ci.yml`

**Evidence:** `pnpm audit` reports 3 high and 4 moderate:

| Severity | Package | Path | Fixed in |
| --- | --- | --- | --- |
| high | `postcss` | `apps/web > next > postcss` | >= 8.5.18 |
| high | `postcss` | `apps/web > next > postcss` | >= 8.5.12 |
| high | `deepmerge-ts` | `packages/database > prisma > @prisma/config > deepmerge-ts` | >= 8.0.0 |
| moderate | `postcss` ×2 | `apps/web > next > postcss` | >= 8.5.23 |
| moderate | `vitest` | `apps/api > vitest` | >= 4.1.11 |
| moderate | `@vitest/mocker` | `apps/api > vitest > @vitest/mocker` | >= 4.1.11 |

The CI workflow runs install, generate, typecheck, test and build. It has no audit step, no secret scanning and no dependency review, so none of this fails a pull request.

**Failure scenario:** The `postcss` path-traversal advisories are build-time arbitrary file reads via attacker-controlled `sourceMappingURL` — relevant the moment CSS from any third party enters the build. More importantly, nothing in the pipeline will surface the *next* advisory either.

**Remediation:**

1. Add `pnpm audit --audit-level=high` as a CI step, and `pnpm dedupe` / a `pnpm.overrides` entry to pull `postcss` and `deepmerge-ts` to patched versions.
2. Add secret scanning (Gitleaks or GitHub's native scanning) and `actions/dependency-review-action` on pull requests.
3. Pin GitHub Actions to commit SHAs rather than floating tags (`actions/checkout@v4` → `@<sha>`), so a compromised tag cannot alter your CI.

---

## Medium

### M1 — `pnpm check` fails on a clean clone

**File:** `package.json:12,14`

**Evidence:** `check` = `lint && typecheck && test && build`. `lint` = `pnpm -r lint`, which runs `tsc --noEmit` in every package in parallel. `apps/api` resolves `@rescue/contracts` through its `exports` map to `dist/index.d.ts`, which does not exist until contracts is built. `typecheck` builds contracts and database first; `lint` does not.

```
apps/api lint: src/lib/job-store.ts(2,42): error TS2307: Cannot find module '@rescue/contracts'
apps/api lint: src/lib/triage.ts(7,45): error TS7006: Parameter 'sum' implicitly has an 'any' type
... 6 errors, exit 2
```

**Failure scenario:** The command the README tells contributors to run fails on their first attempt, and the errors point at innocent code. CI hides this because it never runs `lint`.

**Remediation:** Either reorder `check` to `typecheck && lint && test && build`, or give `lint` the same prerequisite build step. Better, adopt TypeScript project references (`composite: true` + `tsc -b`) so build ordering is derived from the dependency graph instead of being hand-maintained in npm scripts.

### M2 — No persistence; the database package is dead weight

**Files:** `apps/api/src/app.ts:14`, `apps/api/package.json:20`

**Evidence:** `buildApp` instantiates `InMemoryJobStore` unconditionally. `@rescue/api` declares `@rescue/database` as a dependency but imports it nowhere.

**Failure scenario:** Every job is lost on restart, deploy or crash, and a multi-instance deployment gives each instance a different view of reality. The declared-but-unused dependency also hides the gap from a casual dependency review.

**Remediation:** Implement `PrismaJobStore` against the existing `JobStore` interface, select it by configuration, and keep `InMemoryJobStore` for tests only. Add an integration test that runs against a real Postgres (Testcontainers or the existing `docker-compose` service).

### M3 — Unbounded list endpoint

**File:** `apps/api/src/lib/job-store.ts:18-20`, `apps/api/src/routes/jobs.ts:13-16`

**Evidence:** `list()` materialises every job into an array, sorts it, and returns all of it. No `limit`, no cursor, no cap.

**Failure scenario:** Response size and sort cost grow linearly with total platform volume. With the in-memory store this is an availability risk well before it is a performance one; against Postgres it becomes a trivially triggerable expensive query.

**Remediation:** Add cursor pagination — `?limit` (default 25, max 100) and `?cursor` on `(createdAt, id)` — and return `meta.nextCursor` in the documented envelope. The `@@index([organizationId, createdAt])` in the schema already supports this.

### M4 — No migrations exist

**File:** `packages/database/prisma/` (no `migrations/` directory)

**Evidence:** The schema has never been migrated. CI runs `pnpm db:generate` (client generation) but never `prisma migrate diff` or `migrate deploy`. `README.md` instructs developers to run `pnpm db:migrate`, which is `prisma migrate dev` — a development-only command that can reset data.

**Failure scenario:** There is no reviewable, replayable path from an empty database to the current schema, and no production deployment story. The first migration generated later will bundle every change made up to that point into one unreviewed diff.

**Remediation:** Generate the initial migration now and commit it. Use `prisma migrate deploy` in deployment pipelines, never `migrate dev`. Add a CI step running `prisma migrate diff --exit-code` against the committed migrations so schema edits without a migration fail the build.

### M5 — Build requires network egress to `binaries.prisma.sh`

**File:** `packages/database/package.json:15`, `.github/workflows/ci.yml:19`

**Evidence:** `pnpm db:generate` failed in this audit environment:

```
Error: Failed to fetch the engine file at
https://binaries.prisma.sh/all_commits/c2990.../libquery_engine.so.node.gz - 403 Forbidden
```

Generation only succeeded after pointing `PRISMA_QUERY_ENGINE_LIBRARY` at a local stub. This is an environment restriction rather than a code defect, but it is a real build-time dependency on a third-party host outside the npm registry.

**Failure scenario:** Any CI runner, air-gapped build or restricted corporate network without that specific host allow-listed cannot build the project. It is also an unpinned supply-chain ingress point that `pnpm-lock.yaml` does not cover.

**Remediation:** Allow-list `binaries.prisma.sh` in your CI egress policy and cache the engines between runs, or move to Prisma's WASM/driver-adapter engine so everything ships through the registry and is covered by the lockfile. Document the requirement in `README.md`.

### M6 — Prisma client is constructed as an import side effect

**File:** `packages/database/src/index.ts:4-6`

**Evidence:** `export const db = ... new PrismaClient(...)` runs at module load. Confirmed: importing the built module with no usable engine throws `PrismaClientInitializationError` as an unhandled rejection during import, not at first query. The `globalThis` singleton is also retained in every non-production environment, tests included.

**Failure scenario:** Import-time failures are hard to diagnose, cannot be caught by the caller, and break any tooling that merely imports the module for its types. Shared global state leaks connections across test files.

**Remediation:** Export a lazy `getDb()` (or a factory) instead of a constructed instance, so connection setup happens at first use inside a try/catch, and tests can inject their own client.

### M7 — CORS is credentialed with no CSRF strategy

**File:** `apps/api/src/app.ts:14`

**Evidence:** `cors({ origin: config.WEB_ORIGIN, credentials: true })`. The single-origin restriction is correct, but `credentials: true` signals an intent to use cookies, and no CSRF defence exists.

**Failure scenario:** Not exploitable today — there are no cookies and no auth. It becomes exploitable the moment cookie sessions are added in Phase 2, and by then the setting will look deliberate and reviewed.

**Remediation:** Decide now. Either use `Authorization: Bearer` tokens and set `credentials: false`, or use cookies with `SameSite=Lax`, `Secure`, `HttpOnly` plus the double-submit or origin-check pattern. Validate `WEB_ORIGIN` at startup and reject `*`.

### M8 — `lint` does not lint

**Files:** all four `package.json` files

**Evidence:** Every package defines `"lint": "tsc --noEmit"`, which duplicates `typecheck`. There is no ESLint, no `eslint-plugin-security`, no `eslint-config-next`, no Prettier check — although `prettier` is a root devDependency.

**Failure scenario:** No static analysis catches floating promises, unsafe `any`, missing `await`, React hook violations or the Next.js-specific mistakes that `eslint-config-next` exists to catch. Formatting is unenforced despite Prettier being installed.

**Remediation:** Add ESLint with `@typescript-eslint` (type-aware rules), `eslint-config-next` for `apps/web`, and `eslint-plugin-security` for `apps/api`. Make `lint` run ESLint plus `prettier --check`, and keep `typecheck` separate.

### M9 — Test coverage is effectively nil

**Files:** `apps/api/tests/app.test.ts` and three `"test": "node --test"` stubs

**Evidence:** `pnpm test` runs 3 tests, all in `apps/api`. `packages/contracts`, `packages/database` and `apps/web` each report `# tests 0` and exit 0, so their scripts look green while asserting nothing.

**Failure scenario:** A green CI badge on a suite that tests almost nothing is worse than no badge — it is a false assurance that will be trusted during Phase 2, exactly when tenant-isolation regressions become possible.

**Remediation:** Test the Zod contracts directly (boundary values, the German postal-code regex, rejection of unknown keys). Add component and Playwright tests for `apps/web`. Add a coverage threshold to CI. Replace the empty `node --test` stubs with real suites, or remove the scripts so the gap is visible rather than disguised.

### M10 — Development infrastructure ships with static credentials on all interfaces

**File:** `docker-compose.yml`

**Evidence:** Postgres `rescue:rescue` on `5432`, MinIO `minio:miniosecret` on `9000`/`9001`, Redis unauthenticated on `6379`. All use the `ports:` short syntax, which binds `0.0.0.0`. The MinIO image is `minio/minio:latest` — an unpinned tag.

**Failure scenario:** On any shared network these are three open services with published credentials. The floating `latest` tag also means two developers can silently run different builds, and a compromised upstream tag propagates immediately.

**Remediation:** Bind to loopback (`"127.0.0.1:5432:5432"`). Pin image digests. Move credentials into a gitignored `.env` consumed via `env_file`, keeping `.env.example` as the template.

### M11 — Security-critical domains are unimplemented

**Evidence:** No code exists for provider eligibility, quotes and monetary handling, assignment offers and fallback, or evidence uploads. `docs/ARCHITECTURE.md` flags each as a trust boundary.

**Failure scenario:** This is expected at Phase 1 and is recorded so it is not mistaken for completed work. Each will introduce its own Critical-class surface — eligibility bypass, monetary rounding and currency handling, offer-acceptance race conditions, and unrestricted upload.

**Remediation:** Treat every item in the Phase 2 list as requiring its own threat model and test suite before merge. In particular: integer euro cents end to end with no floating point; `SELECT ... FOR UPDATE` or an equivalent guard on offer acceptance; signed upload URLs with a MIME allow-list, size cap, malware scan and EXIF stripping.

---

## Low

- **L1 — `sharp` is allow-listed to run install scripts but is not a dependency.** `pnpm-workspace.yaml:9`. Remove it; do not pre-authorise build scripts for packages you do not use.
- **L2 — `allowBuilds` duplicates `onlyBuiltDependencies` and has already drifted** (`sharp` appears in one, not the other). `pnpm-workspace.yaml`. Keep one list.
- **L3 — Zod issues are echoed verbatim to the client.** `apps/api/src/app.ts:18`. `error.issues` exposes internal field paths and schema structure. Map to a stable field/message shape instead.
- **L4 — `apiRequest` throws opaquely on non-JSON responses.** `apps/web/lib/api.ts:6`. A 502 HTML error page makes `response.json()` throw a parse error that surfaces to the user as "Unexpected token". Check `content-type` before parsing and handle non-JSON explicitly.
- **L5 — `/v1/health` is a liveness probe only.** `apps/api/src/routes/health.ts`. Add a separate `/v1/ready` that checks database and Redis, and keep `/health` dependency-free.
- **L6 — The dashboard renders a hardcoded array.** `apps/web/app/dashboard/page.tsx:1`. No loading, empty, error or retry states, contrary to the Phase 3 requirements.
- **L7 — No i18n structure.** German and English support is required but no translation scaffolding exists; all strings are inline English.

---

## Summary

| Severity | Count |
| --- | --- |
| Critical | 4 |
| High | 7 |
| Medium | 11 |
| Low | 7 |

**Recommended order of work.** C1 first — authentication is the precondition for fixing C2, C3 and C4, since each remediation needs a trustworthy `request.user`. Then C2–C4 together as one change to the store interface, so the type system enforces tenant scoping at every call site. Then H3 and H6 (both one-line configuration fixes that materially reduce exposure), then H1/H2, then M1 so `pnpm check` is trustworthy before Phase 2 begins.

Do not deploy to any shared network, and do not process real customer data, until C1–C4 are closed and covered by tests.

## Reproducing the proofs

The proof-of-concept requests in C1–C4, H1 and H2 were run against `buildApp()` and a live `127.0.0.1:4321` server, then removed. They are not committed — they were written as a throwaway `apps/api/tests/exploit.test.ts` plus a short script that issues 140 requests and tallies status codes. Each finding above quotes that run's actual output.
