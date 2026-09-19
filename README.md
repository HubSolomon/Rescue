# RESCUE Circular Logistics

AI-assisted B2B exception logistics for failed bulky deliveries, returns and reusable company surplus.

## Repository

- `apps/web`: Next.js customer and operations interface
- `apps/api`: Fastify REST API
- `packages/contracts`: shared Zod request/response contracts
- `packages/database`: Prisma schema, migrations and client
- `docs/ARCHITECTURE.md`: system architecture and trust boundaries
- `docs/adr/`: architecture decision records
- `docs/audits/`: security audits and phase reports

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
applies the migrations and runs the suite — every step inside the container, so
the host needs Docker and nothing else. No local PostgreSQL, no `psql` on the
PATH. If you would rather run your own server, the script prints the commands.

The store conformance suite runs against both implementations, so the
in-memory and PostgreSQL stores are held to identical behaviour.

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
- `JobEvent` and `AuditLog` are append-only, enforced by database triggers.

## GitHub

Never commit `.env` or credentials. Work on a branch and open a pull request;
do not push to `main`.
