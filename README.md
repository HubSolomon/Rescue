# RESCUE Circular Logistics

AI-assisted B2B exception logistics for failed bulky deliveries, returns and reusable company surplus.

## Repository

- `apps/web`: Next.js customer and operations interface
- `apps/api`: Fastify REST API
- `packages/contracts`: shared Zod request/response contracts
- `packages/database`: Prisma schema, migrations and client
- `docs/ARCHITECTURE.md`: system architecture and trust boundaries
- `docs/adr/`: architecture decision records
- `docs/audits/`: security audits, phase reports and the data inventory
- `docs/runbooks/`: deployment, backup and restore, incident response
- `deploy/`: Dockerfiles, the production environment contract, Prometheus rules

## Local setup

Node 22.13 or later is required (`.nvmrc` pins it). No database is needed to
run the API in development — it falls back to an in-memory store.

```bash
corepack enable
cp .env.example .env
pnpm install
pnpm dev
```

`prisma generate` and the workspace package builds run automatically as
prerequisites of `dev`, `test`, `lint`, `typecheck` and `build`, so there is no
ordering to remember and no "works from the repo root only" failure mode.

Open `http://localhost:3000`. The API health endpoint is
`http://localhost:4000/v1/health` and the generated OpenAPI document is at
`http://localhost:4000/v1/openapi.json`.

### With PostgreSQL

Set `DATABASE_URL` and the API switches to the Prisma store automatically.

```bash
docker compose up -d          # or a local postgres
pnpm db:deploy                # applies committed migrations
```

Use `pnpm db:deploy` (`prisma migrate deploy`) for anything but local
schema authoring. `pnpm db:migrate` is `migrate dev` and can reset data.

## Authentication

The API is authenticated by default: every route except `/v1/health`,
`/v1/ready`, `/v1/openapi.json` and the development token endpoint requires a
bearer token.

In production, set `OIDC_ISSUER` and `OIDC_JWKS_URI`; the service refuses to
start without them. In development, with no identity provider configured, mint
a token for a seeded user:

```bash
curl -X POST http://localhost:4000/v1/auth/dev-token \
  -H 'content-type: application/json' \
  -d '{"subject":"dev|customer-admin"}'
```

Seeded subjects: `dev|customer-admin`, `dev|customer-member`,
`dev|other-customer`, `dev|dispatcher`, `dev|compliance`,
`dev|provider-hansa`, `dev|provider-roland`, `dev|admin`. That endpoint does
not exist when `NODE_ENV=production` or when an identity provider is
configured.

**Tenancy is never sent by the client.** The organisation is derived from the
caller's memberships. `X-Organization-Id` and `X-Provider-Id` only *select*
among memberships a user already holds; they cannot grant one.

**Mutations require an `Idempotency-Key` header.** Replaying a key returns the
stored response; reusing it with a different body is a 409.

## Verification

```bash
pnpm check
```

Runs typecheck, lint, tests and build. To also exercise the Prisma store
against real PostgreSQL:

```bash
pnpm test:db
```

That starts the Postgres in `docker-compose.yml`, creates a scratch database,
applies the migrations, provokes every constraint and trigger, and runs the suite — every step inside the container, so
the host needs Docker and nothing else. No local PostgreSQL, no `psql` on the
PATH. If you would rather run your own server, the script prints the commands.

The store conformance suite runs against both implementations, so the
in-memory and PostgreSQL stores are held to identical behaviour.

The constraint harness runs on its own too, against any scratch database:

```bash
DATABASE_URL=postgresql://localhost:5432/rescue_check pnpm check:db
```

Thirty-seven cases, each written so it would *succeed* if the rule were
missing: every CHECK constraint, every append-only trigger, the `TRUNCATE`
guards, and two concurrent sessions proving `FOR UPDATE SKIP LOCKED` hands out
disjoint batches. It asks what the application suite cannot — whether
PostgreSQL still refuses when something reaches it another way.

```bash
pnpm scan:secrets
```

Scans the working tree for committed credentials. No dependencies, and it
prints locations rather than matched text -- echoing a secret into CI output
moves it somewhere with longer retention than the file it was found in.

The browser journeys need a browser, and Playwright downloads its own rather
than using the one on your machine. Once per checkout:

```bash
pnpm e2e:install
pnpm test:e2e
```

`pnpm test:e2e` builds the web app, then starts the API and the web server on
ports 4100 and 3100 and drives the three consoles through thirteen journeys on
desktop Chromium and a Pixel 7. Those ports must be free — a `pnpm dev` left
running elsewhere uses 4000 and 3000, so the two do not collide, but a previous
end-to-end run that was killed mid-way can.

## Security boundary

AI may suggest item classifications, vehicle requirements and providers. It
must never independently approve hazardous materials, determine legal waste
status, settle claims or bypass provider eligibility rules. Those decisions
require deterministic validation and human approval.

Enforced in code:

- Provider eligibility is a pure function over stored facts, with a
  machine-readable reason for every exclusion. AI cannot add a provider it
  excluded.
- `requiresHumanApproval` on a triage suggestion is the literal `true`; only a
  dispatcher moves a job out of `DRAFT`.
- A job reaches `ASSIGNED` only from `QUOTED` with a customer-approved quote.
- Money is integer euro cents end to end, with database CHECK constraints.
- `JobEvent` and `AuditLog` are append-only, enforced by database triggers --
  including a statement-level guard against `TRUNCATE`, which row-level
  triggers do not catch.
- Logs are redacted at the logger: no address, contact or credential reaches
  one. `apps/api/src/lib/redaction.ts` lists every path.
- Retention runs daily and erasure severs a person from the records the law
  requires RESCUE to keep. `docs/audits/DATA_INVENTORY.md`.

## Deploying

Three containers and a migration job, on any host that runs OCI images.
`docs/runbooks/DEPLOYMENT.md` is the procedure; `deploy/.env.production.example`
is the environment contract. Check it before you build anything:

```bash
node scripts/check-deploy-env.mjs .env.production
```

Two things that bite: `NEXT_PUBLIC_API_URL` is baked into the web image at
**build** time, and `REGISTRATION_HASH_KEY` cannot be rotated — a new value
makes every stored vehicle-registration hash permanently unmatchable.

## GitHub

Never commit `.env` or credentials. Work on a branch and open a pull request;
do not push to `main`.
