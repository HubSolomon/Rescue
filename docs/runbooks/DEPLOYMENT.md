# Deployment

Host-agnostic: three containers, a migration job, and an environment contract.
Anything that runs OCI images will do — Railway, Fly, Render, ECS, a pair of
VMs with Compose. Nothing here is tied to one of them.

## What runs

| | Image | Command | Why separate |
| --- | --- | --- | --- |
| **api** | `deploy/docker/api.Dockerfile` | default | Stateless. Scale it freely. |
| **worker** | *the same image* | `node dist/worker/main.js` | A slow notification provider must not add latency to a dispatcher's request, and a worker crash must not take the API with it. |
| **web** | `deploy/docker/web.Dockerfile` | default | Next.js standalone. |
| **migrate** | `deploy/docker/migrate.Dockerfile` | runs once, exits | See below — this is the one people get wrong. |

The API and the worker are **one image with two entrypoints**. They share every
line of code, so building two would mean building the same thing twice and
remembering to deploy both when either changes.

It is safe to run several workers. Claims use `FOR UPDATE SKIP LOCKED`, proven
disjoint by `pnpm check:db`, and the sweep is idempotent.

## The order, and why it is not negotiable

```
1. node scripts/check-deploy-env.mjs .env.production   # 10s, on your terminal
2. build all three images
3. run the migrate job to completion; check it exited 0
4. roll api, worker, web
```

**Migrations are a job, never a startup step.** Two API replicas booting at
once would race `migrate deploy` against each other, and the loser's error is
indistinguishable from a broken deployment. Worse, a migration that fails at
boot leaves the orchestrator restart-looping a container whose actual problem
is in the database.

**Migrate before rolling, not after.** Every migration in this repository is
additive — new tables, columns, triggers — so the old image keeps working
against the new schema while the roll is in progress. That property is what
makes this order safe rather than merely conventional, and **the first
migration that drops or renames a column ends it.** When that day comes it
needs a two-step plan: ship code that tolerates both shapes, roll, then drop.

## Building

```bash
docker build -f deploy/docker/api.Dockerfile     -t rescue-api:$(git rev-parse --short HEAD) .
docker build -f deploy/docker/migrate.Dockerfile -t rescue-migrate:$(git rev-parse --short HEAD) .
docker build -f deploy/docker/web.Dockerfile \
  --build-arg NEXT_PUBLIC_API_URL=https://api.rescue.example \
  -t rescue-web:$(git rev-parse --short HEAD) .
```

**`NEXT_PUBLIC_API_URL` is a build argument, not an environment variable.**
Next inlines it into the browser bundle at build time. Setting it only at
runtime produces an image that works on the machine that built it and calls
`localhost` everywhere else — which presents as "the site loads but nothing
works", with a console full of connection refused. It is the single most
common way this deployment goes wrong, so the preflight refuses without it.

Tag by commit, not `latest`. A rollback needs a tag that names a known build.

## The environment

`deploy/.env.production.example` is the full contract, annotated. The preflight
is the fast way to check it:

```bash
node scripts/check-deploy-env.mjs .env.production
```

It prints names and reasons, never values — it is meant to run in terminals and
CI logs. It does not replace the boot-time check in `parseConfig`, which is the
real guarantee; it is the thing that saves you finding out inside a restart
loop an hour later.

Three that deserve saying out loud:

**`REGISTRATION_HASH_KEY` cannot be rotated.** It keys the vehicle-registration
hashes. A new value does not re-key them; it makes every stored hash
permanently unmatchable. Treat it as write-once, and if it is ever compromised,
that is a data migration rather than an incident action.

**`NODE_ENV=production` removes the development sign-in.** Outside production
the API serves `POST /v1/auth/dev-token`, which mints a session for any seeded
person with no password. Deployed publicly, that is anonymous access to the
dispatcher console and every tenant's jobs. `parseConfig` refuses to start
production without a real OIDC provider precisely so this cannot be an
oversight.

**`TRUST_PROXY_HOPS` must match reality.** Too low and every client shares one
rate-limit bucket keyed on the load balancer. Too high and a client can forge
`X-Forwarded-For` and get a bucket to itself.

## Identity

Any OIDC provider. The API verifies against the JWKS and never issues its own
tokens.

- `OIDC_ISSUER` and `OIDC_JWKS_URI` — both, or neither. A half-configured
  provider silently falls back to the development issuer, so the config
  refuses that combination.
- `OIDC_AUDIENCE` must match the audience the provider stamps.
- Users are matched on the `sub` claim. A person who has been erased has their
  subject replaced with `erased:<id>`, which no provider can issue — so signing
  in again creates a new person rather than reviving the erased record.

## Storage

Evidence photographs go to S3 or anything that speaks it. The adapter signs
SigV4 by hand rather than pulling the AWS SDK — forty megabytes and several
hundred transitive packages to produce three signatures.

- **AWS**: leave `S3_ENDPOINT` blank; virtual-host addressing is inferred.
- **MinIO, R2, Backblaze**: set `S3_ENDPOINT`; path addressing is inferred.
  Override with `S3_ADDRESSING` if the gateway disagrees.
- `S3_REGION` is signed over even by gateways that ignore it. MinIO wants
  `us-east-1`.

**Set a bucket size policy.** The presigned PUT deliberately does not sign
`content-length`, because signing it makes any proxy that re-chunks the upload
produce a signature mismatch the user sees as "upload failed" with no
explanation. The limit belongs on the bucket, which is where a limit a client
cannot avoid belongs.

The bucket must not be public. Reads go through short-lived presigned GETs
issued only after the route has authorised the caller.

## After the first deploy

In order, because each depends on the last:

1. `GET /v1/health` on the API — liveness, touches nothing.
2. `GET /v1/ready` — checks the database. Green `/health` with red `/ready` is
   a dependency problem, not a process problem.
3. Sign in through the real provider and open one job.
4. Upload one piece of evidence and download it again. This is the only test of
   the S3 wiring that means anything; everything before it passes with a
   misconfigured bucket.
5. Check the worker: `rescue_dispatch_sweep_runs_total` should be increasing.
6. Point Prometheus at both — `deploy/prometheus/README.md`. **Two targets.**
   The sweep and retention counters exist only in the worker, so scraping the
   API alone leaves those alerts permanently pending, which reads as healthy.

## Rolling back

The API and web are stateless: redeploy the previous tag.

The schema is the constraint. There is **no down migration for anything**, and
none is planned. Rolling the schema back means restoring a dump, which means
losing everything since it — see `docs/runbooks/BACKUP_AND_RESTORE.md`. Because
every migration so far is additive, an older image runs against a newer schema,
so in practice a rollback is an image change and the schema simply stays ahead.

## What this does not cover

- **Backups are not scheduled.** The procedure is proven and nothing runs it.
  Before real data: a nightly `pg_dump`, WAL archiving, an offsite copy, and a
  calendar entry for the monthly restore test.
- **Payments are a mock.** The bookkeeping is correct and no money moves.
- **Escalations reach nobody.** No on-call address exists in the system, so the
  dispatch sweep's safety valve logs to a null recipient. Alert on
  `rescue_dispatch_sweep_actions_total{action="escalated"}` until it does.
- **Alertmanager receivers are placeholders.** One with no receiver accepts
  every alert and drops it silently.
- **No CDN, no WAF, no autoscaling policy.** Deliberately: those are decisions
  about a specific host, and this document is about the part that is the same
  everywhere.
