# Threat model

**Date:** 2026-09-19 · **Scope:** the API, the worker, the three consoles, and
the boundaries between them.

Not a checklist walk. The method was to take the three things this system is
worth attacking for, work backwards to how, and then check what actually stops
each one — naming the mitigation's test where there is one, and saying plainly
where there is not.

## 1. What is worth taking

1. **Addresses and movement.** A dispatcher's console shows where goods are
   being collected from, when, and by whom. For a customer organisation that is
   commercially sensitive; for a private address it is worse than that.
2. **Money.** Quotes, captures and payouts. The attack is not "steal the
   ledger", it is "become the provider who gets paid".
3. **The audit trail.** Not to read — to change. Everything else in this
   document is survivable if the record of it is intact.

## 2. The boundaries

```
browser ── httpOnly cookie ──> Next.js server ── bearer ──> Fastify API ──> PostgreSQL
                                                                 │
                                                                 ├──> object storage (evidence)
                                                                 └──> Nominatim / OSRM (third party)
worker ──────────────────────────────────────────────────────────┘
```

The access token never reaches browser JavaScript. The web app holds it in an
httpOnly cookie and attaches it server-side, so an XSS in a console cannot read
it — there is an e2e test that asserts the token is absent from
`localStorage`, `sessionStorage` and `document.cookie`.

## 3. Tenancy — the one that matters most

**Threat:** a customer reads another customer's jobs. A provider reads a job it
was never offered.

Every store read takes a `Scope`, and the scope comes from the resolved
principal, never from a parameter. `findJob` for another tenant returns `null`
rather than a 403 — a 403 confirms the id exists, which is itself a leak, and
the conformance suite asserts the null for both store implementations.

The `X-Organization-Id` header *selects* among memberships the caller already
holds and can never introduce one. That is the whole tenant-spoofing surface
and it is closed by construction.

An e2e journey drives it through the real UI: one customer, another customer's
job URL, and the console shows not-found.

**Residual:** staff scope reads across tenants by design. A compromised
dispatcher account sees everything. Mitigated only by the audit log — see §7.

## 4. Authorisation

**Threat:** a provider approves its own quote; a driver vets its own documents.

Protection is a global `onRequest` hook with an explicit public allow-list:
`/v1/health`, `/v1/ready`, `/v1/openapi.json`, `/v1/auth/dev-token` and
`/metrics`. Routes are protected by default and exemptions are visible in one
place. The reverse — nothing protected, protection remembered per route — was
finding C1 in the foundation audit.

`/metrics` is on that list because a Prometheus scraper has no principal; it
carries its own bearer token instead, compared in constant time, and in
production the route is not registered at all without one.

**Production cannot boot with the development identity provider.** It is not
discouraged, it is unconstructable: `buildVerifier` throws without
`OIDC_ISSUER` and `OIDC_JWKS_URI`.

## 5. Money

**Threat:** become the paid provider, or be paid twice.

- Offer acceptance is a race resolved in the database, not in the application.
  Two providers accepting the same offer: one wins, one gets a conflict. In the
  conformance suite for both stores.
- The payout is **what the provider accepted**, carried forward, not recomputed
  at payout time — so nothing between acceptance and payment can change the
  figure.
- Payment handlers guard on the ledger, not on outbox delivery. Delivery is
  at-least-once, so a duplicate message is expected; a duplicate charge is not.
- `UPDATE` and `DELETE` on `LedgerEntry` are refused by trigger. Corrections are
  opposite entries.
- CHECK constraints refuse a zero amount, a sign that disagrees with the kind,
  and a positive payout. All provoked against real PostgreSQL 16.

**Residual:** the payment gateway is a mock. Every guarantee above is about
RESCUE's record of what happened, not about money actually moving.

## 6. Evidence

**Threat:** read another job's photographs; upload something hostile.

Upload and download are short-lived signed tickets. The HTTP method is part of
the signed string, so an upload signature cannot be replayed as a download.
The signer does not decide who may read — the route authorises first and then
asks for a ticket.

**Residual, and it is real:** the mock adapter signs URLs against a bucket
nothing enforces. MIME type and size are checked at ticket time, not at upload
time, so with a real bucket the policy must be enforced by the bucket too.
Nothing has ever been uploaded to real object storage.

## 7. The audit trail

**Threat:** change what happened.

`JobEvent` and `AuditLog` are append-only in PostgreSQL, not only in the code:
`BEFORE UPDATE OR DELETE` triggers refuse both. Every transition carries a
non-null actor, and anything the system does on its own is attributed to a
named system actor rather than to a blank.

**The gap this audit found.** Row-level triggers do not fire on `TRUNCATE`.
Until migration `20260919000400`, one statement could empty the audit log, the
ledger and the suggestion table, and nothing would record that it had happened
— because the record is one of the tables. Found by a restore drill, not by
reading the code. Statement-level `BEFORE TRUNCATE` triggers now refuse it,
including when it arrives by cascade from `Job`, and there is a test.

**Residual:** a database superuser can drop a trigger. Nothing inside the
database defends against the database's owner; that is an access-control
problem, not a schema one.

## 8. Input and denial of service

- Zod on every body. Validation errors return field paths and messages and
  **never echo the received value** — finding L3, because an error message
  containing the input is a reflection primitive.
- Rate limited per caller. `TRUST_PROXY_HOPS` defaults to 0, so
  `X-Forwarded-For` is not trusted and a client cannot choose its own bucket by
  forging it.
- 2 MB body limit.
- Helmet, and CORS restricted to `WEB_ORIGIN`, which may not be a wildcard in
  production.

**Residual:** the rate limiter is in-process. Several API instances multiply
the effective limit by the instance count. A shared store is needed before
horizontal scaling means anything for abuse control.

## 9. Third parties

Nominatim and OSRM receive postal codes. In a sparse postcode that is arguably
personal data, and there is **no DPA with either** — they are volunteer-run
public services. Self-hosting or a contracted provider is the fix; the port
makes that a constructor change.

A failure there is contained: the cache falls back to the offline estimate with
`isRoadDistance: false`, so unavailability degrades the answer visibly rather
than blocking the request.

## 10. Supply chain

`pnpm audit` at high, a lockfile-drift check, and a dependency-free secret
scanner that runs **before** `pnpm install` so a malicious postinstall script
has not yet executed in that job. `persist-credentials: false` on every
checkout, or the token sits in `.git/config` for any later step to read.

**Residual:** actions are pinned to mutable tags, not digests. `actions/checkout@v4`
is whatever that tag points at today. See the readiness report for the fix.

## 11. Ranked residual risk

| | Risk | Why it is where it is |
| --- | --- | --- |
| 1 | No alerting on anything | Every mitigation above assumes somebody notices. Nothing pages. |
| 2 | Evidence storage is a mock | The largest concentration of personal data, on an adapter that has never touched a real bucket. |
| 3 | Payment gateway is a mock | Correct bookkeeping for money that has never moved. |
| 4 | Escalations reach nobody | The dispatch safety valve logs to a null recipient. |
| 5 | Third parties without a DPA | Legal exposure, with a technically easy fix. |
| 6 | In-process rate limiting | Becomes wrong the moment there are two instances. |
| 7 | Actions on mutable tags | Cheap to fix; listed because it is still true. |

## 12. What was checked and found sound

Written down so a re-audit does not repeat it: tenant isolation on both stores,
the offer race, the append-only triggers (now including `TRUNCATE`), token
handling in the browser, the deny-by-default route hook, production refusing the
development identity provider, validation errors not echoing input, proxy trust
defaulting off, and the human-in-the-loop guarantee — proven structurally,
behaviourally and adversarially.
