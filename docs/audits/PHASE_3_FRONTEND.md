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
| Provider | `/provider`, `/provider/jobs/[id]`, `/provider/fleet`, `/provider/onboarding` | Offer inbox with expiry, start and complete work, upload proof, set availability, register the company and its vehicles and documents |

A fifth route, `/styleguide`, renders the design system from the product's own
stylesheet and components — tokens, every component, and all four states at
once. It is a route rather than a separate document so it cannot describe a
product that has since changed.

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

## 4. Two Phase 3 requirements closed afterwards

**Provider availability.** The brief asks for it and nothing implemented it.
Added as a field the provider owns — `acceptingWork` plus an optional note —
kept deliberately separate from `status`, which is RESCUE's compliance decision
and staff-only. Conflating them would mean a provider pausing for an afternoon
looked identical to one we had suspended, and only an administrator could
switch it back on. Dispatch reports the two as different exclusion reasons.
Resuming clears the note, enforced by a CHECK constraint as well as by the
form, so a stale "van in the workshop" cannot sit beside a provider who is
taking work again. Migration `20260919000200_provider_availability`, verified
against PostgreSQL 16: the default, the constraint in both directions, and the
index.

**Proof download.** The message key existed and nothing rendered it. The
customer paid for the recovery and is entitled to the proof of it, so the read
is scoped by the parent job rather than restricted to the provider that
uploaded it — a customer reaches their own organisation's evidence, a provider
the jobs it holds or held, staff everything, and anything outside that is
reported absent rather than forbidden. The page links to a route handler in the
web app, not to storage: the signed URL is minted server-side at click time, so
it is fresh when used and never appears in the page's HTML. The HTTP method is
part of the signed string, so an upload signature cannot be replayed as a
download one. Only `UPLOADED` rows are downloadable; a requested-but-unfilled
slot would hand out a link that looks like missing proof rather than absent
proof.

## 5. Brand

The supplied logo artwork replaced the mark that had been drawn in CSS, and it
changed more than a picture.

**The colour tokens now come from the artwork.** Navy, green and amber were
sampled off the mark rather than chosen beside it — `#0d2b44`, `#0d9b67`,
`#f6a641`, each within a few units of what the stylesheet already had, which is
exactly why the mismatch would never have been noticed by eye and would have
shown the moment the real lockup sat next to a heading. A unit test pins the
three values to the artwork so they cannot drift apart again.

**Sampling exposed a contrast failure that predated it.** White on the brand
green is 3.6:1, and the old green was 3.4:1. The primary button is a 16px bold
label, which is not large text, so it needed 4.5:1 and had never had it — the
same for the eyebrow, which is green text on white. Rather than quietly darken
the brand, the system now carries two greens: `--green` is the mark's own value
and fills shapes only, and `--green-strong` (`#0b8458`, the same hue and
saturation darkened to 4.7:1) carries every button and every piece of green
text. The split is stated in the design system and enforced by a test that
fails if `.button` ever takes the brand green again.

**Every documented colour is now a token.** The audit turned up a gap between
what the design system described — thirty-odd colours with usage notes — and
what the stylesheet declared: eight custom properties, with the rest as literals
inside rules. All of them are now on `:root`, so `tests/contrast.test.ts` can
read the real values and check twenty-eight pairs on every run instead of
trusting prose.

**Assets.** `apps/web/public/brand/` holds the lockup, the mark, a 512px icon
(also the app's favicon) and both van liveries. The nav carries the mark plus
the name in the interface face rather than the lockup: at 34px the lockup's
CIRCULAR LOGISTICS line is about three pixels tall and stops being type. The
landing page gained a fleet section showing both liveries, and the styleguide
gained Logo and Fleet panels with the usage rules. There is no SVG — the source
artwork is raster, and tracing it would produce a mark that is nearly but not
exactly this one.

## 6. Testing

| Layer | Count | Notes |
| --- | --- | --- |
| API unit and integration | 190 passing, 1 skipped | Skipped suite is `PrismaStore`, which needs a query engine binary |
| Web component and tokens | 51 passing | Vitest + Testing Library, plus 28 contrast assertions read out of `globals.css` |
| End-to-end | 26 passing | 13 journeys × desktop Chromium and Pixel 7 |

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

## 7. Known limitations

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
- The provider console's availability is a single switch. Scheduled availability
  — a date range, or hours of the day — is Phase 4 work alongside offer expiry.
- The proof download returns a signed URL from the mock storage signer, which
  stores nothing. The redirect and the signature are real; the object is not.
- The brand artwork is raster only. A vector mark would sharpen the favicon and
  let the arrow be recoloured for a dark theme; both are blocked until someone
  supplies or draws one.
- No webfont. The stack starts with Inter and nothing loads it, so most viewers
  see their system UI face — including the wordmark set in type beside the mark
  in the nav, which is therefore not the lockup's own letterforms.
