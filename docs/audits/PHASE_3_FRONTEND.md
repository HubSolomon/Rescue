# Phase 3 — Frontend

**Branch:** `claude/phase-3-frontend`
**Date:** 2026-09-19
**Baseline:** `85040a6` (Phase 2 backend)

Three consoles — customer, dispatcher, provider — in German first and English
second, on Next.js 15 App Router and React 19.

## 1. Architecture

**The access token never reaches the browser.** Sign-in exchanges a subject for
a token in a Server Action and writes it to an httpOnly, SameSite=Lax cookie.
`lib/api.ts` is `server-only`: it reads that cookie and calls the API from the
server. No page payload, no React state, no `localStorage`. An end-to-end test
asserts the absence rather than trusting the design.

**Reads are Server Components; writes are Server Actions.** Every page is an
async server component that fetches what it renders. Forms post to Server
Actions through `useActionState`, so they work before hydration and the pending
state comes from `useFormStatus` rather than a hand-rolled boolean. Idempotency
keys are generated server-side per POST, so a double-submitted form replays the
stored response instead of creating a second job.

**Role decides what exists, not what is hidden.** `requireRole` runs before a
page renders and redirects to `/no-access`. The API enforces the same rules
independently — hiding a button is presentation, refusing the request is the
control — and a test signs in as a dispatcher and asks for a provider-only route
to prove both halves agree.

**Localisation is two typed catalogues, no library.** `messages.de.ts` is the
source of truth and `Messages = typeof de`; `messages.en.ts` is typed against
it, so a missing or renamed German key is a compile error in English. The locale
is the first path segment, `/de` is the default, and middleware redirects a bare
path to it.

## 2. Surfaces

| Surface | Routes | What it does |
| --- | --- | --- |
| Customer | `/customer`, `/customer/new`, `/customer/[id]` | Raise a recovery, watch its status, approve or reject the quote, cancel |
| Dispatcher | `/dispatch`, `/dispatch/[id]` | Triage queue, approve the AI assessment, price the job, offer it to eligible partners with exclusion reasons |
| Provider | `/provider`, `/provider/jobs/[id]`, `/provider/fleet`, `/provider/onboarding` | Offer inbox with expiry, start and complete work, upload proof, register the company and its vehicles and documents |

The AI assessment is advisory everywhere it appears and is labelled as such; the
dispatcher's approval is the decision that moves the job.

## 3. Defects found and fixed during end-to-end testing

**A bodyless POST was answered with 400.** `lib/api.ts` set
`content-type: application/json` on every POST, including the ones that carry
nothing — start, complete, evidence confirmation. Fastify's default parser
rejects that combination with `FST_ERR_CTP_EMPTY_JSON_BODY`, so the provider
pressed "Abholung starten", the API returned 400, and the job silently stayed
`ASSIGNED`. Fixed on both sides: the client declares JSON only when it sends
JSON, and the API now parses an empty body as `{}` so a habitual header from any
client is not a protocol error. Endpoints that require a body still fail Zod
validation with field detail. Four regression tests.

**The navigation disappeared on a phone.** `.nav-links a:not(.button)` was
`display:none` below 850px, which left a provider — the one user who is
explicitly on a phone, in a van — with no route to their fleet, their jobs, or
the language toggle. The bar now wraps onto a second line. The mobile Playwright
project (Pixel 7) covers it.

**Providers could not see the jobs they held.** Scope was organisation-or-staff
only, so a provider's own assigned job 404'd. Added a `provider` scope to the
store port, honoured by both adapters; quotes stay customer-only, because a
provider knows its payout and the customer's price is not its business.

## 4. Testing

| Layer | Count | Notes |
| --- | --- | --- |
| API unit and integration | 170 passing, 1 skipped | Skipped suite is `PrismaStore`, which needs a query engine binary |
| Web component | 23 passing | Vitest + Testing Library |
| End-to-end | 20 passing | 10 journeys × desktop Chromium and Pixel 7 |

The end-to-end suite runs the real API and the real web build together against
the in-memory store and the development identity provider. Nothing is mocked:
the point is to prove the two halves agree, including the session cookie and the
tenant rules. The headline test drives one recovery through all three roles —
request, triage, quote, customer approval, offer, provider acceptance, start,
proof, completion — and then checks the customer sees it finished.

Assertions are on durable state, not on success notes. A note rendered inside a
panel that revalidation removes never appears; asserting on it produces a test
that fails for the wrong reason. Where a click can land in the window between
HTML arriving and React hydrating, `openRow` retries — that is a real gap a
person closes by clicking again, and the test does the same rather than
pretending the first click always takes.

## 5. Known limitations

- `PrismaStore` is still unexecuted. The container cannot reach
  `binaries.prisma.sh`, so the conformance suite that both adapters share has
  only ever run against `MemoryStore`. The migrations themselves were verified
  against a real PostgreSQL 16.
- Evidence upload uses the mock storage signer; the PUT is expected to fail in
  development and the API is the authority on whether the evidence row counts.
  Real object storage plus a malware scan is Phase 4.
- Accessibility is built in — skip link, labelled fields, `aria-invalid`,
  `prefers-reduced-motion`, focus order — but has not been checked with a
  screen reader or an automated axe pass.
- No client-side pagination beyond the API's cursor; lists request a fixed limit.
