# Phase 4 — Async operations and integrations

**Branch:** `claude/phase-3-frontend`
**Date:** 2026-09-19
**Baseline:** `c231575` (Phase 3 frontend, with the brand)

Everything the outside world touches now goes through a port with a
development adapter behind it, and everything that happens on its own goes
through one durable queue.

## 1. The bug that set the shape

Offers carried an `expiresAt`. The provider console drew *Abgelaufen* when it
passed. A store method expired them and an endpoint exposed it, and the
conformance suite tested that the method was idempotent.

Nothing ever called any of it.

An offer therefore expired only in the eye of whoever happened to be looking
at it. The row still said `PENDING`, the job still sat in `QUOTED` with no
assignment, and nobody was coming. Fixing it properly needed a process that
runs on a timer, and a process that runs on a timer needs somewhere durable to
put the work — so the outbox came first and the expiry sweep came second.

## 2. The outbox

**It is a projection of the event stream, not a second thing to remember.**
Every transition already wrote a `JobEvent` inside its own transaction. Both
stores now write the outbox row in the same place, so "the job moved" and
"somebody will be told" are one atomic fact. There is no call site that can
forget, and no intent that can survive a rolled-back transition.

`outboxForEvent` is the one map from event type to topic. An event that is not
in it produces no row, which keeps the table a work queue rather than a
duplicate log — and means adding a transition does not silently add a
notification to someone's inbox.

**The dedupe key identifies the intent, never the attempt.** It is built from
the topic, the job and the identifier of the occurrence — an offer id, a quote
id — and never from a timestamp or a random value, because either would make
every retry look like new work. The column is unique, so a retried transaction
re-enqueues and gets one row.

**Delivery is at-least-once, deliberately.** The row is marked delivered after
the handler runs, so a crash in between causes a duplicate rather than a
silent loss. Every handler is written to survive that: the payment handlers
guard on the ledger, not on delivery.

**A dead letter stays.** Five attempts with exponential backoff, then the row
stops being claimed and is logged at error level. It is not deleted, because a
dead letter that tidies itself away is a lost delivery nobody can find
afterwards.

`claimOutbox` uses `FOR UPDATE SKIP LOCKED`, so several workers take disjoint
batches; the claim pushes `availableAt` forward as a lease, so a worker that
dies mid-delivery releases its messages by timeout instead of holding them.

## 3. The sweep

Expires due offers, then covers the jobs they uncovered: offers to providers
that have not yet been asked, three rounds by default, then it stops and
records a `DISPATCH_ESCALATED` event for a person.

**Bounded on purpose.** An unbounded retry loop keeps a job looking handled
while nobody is actually coming. A bounded one fails loudly, which is the
behaviour a dispatcher can plan around.

**It moves nothing.** Expiry changes offers, re-offering creates offers,
escalation records an event. The job's own status is untouched — and the
payout carries over from the previous round rather than being recomputed,
because raising a payout is a pricing decision and pricing belongs to a
dispatcher.

Most of its tests are for the cases where it must do nothing: a job somebody
already accepted, a cancelled job, one with a live offer still out, one whose
quote was never approved. Those are the cases where acting would create a
second claimant on work that already has one.

## 4. The ports

| Port | Development adapter | Real adapter |
| --- | --- | --- |
| Notifications | Logs; never sends. Subject at info, body at debug, because a body can contain an address and logs are the least access-controlled thing in the system | — |
| Payments | Deterministic: the same job always produces the same reference. Refuses a capture over its authorisation, a fractional amount, an unknown reference | — |
| Maps | The postal-code estimate that was already here, now honest about what it is | **OpenStreetMap** — Nominatim geocoding, OSRM routing |
| AI | A stub that answers with the rules engine's output, so the validated path runs in every development run | — |

**Recipients come from stored records, never from the message payload.** A
payload is written by whatever caused the event; letting it name its own
audience would make any event a redirect. There is a test that sends an
attacker's address in a payload and checks it goes nowhere.

## 5. Money

The ledger is append-only, in integer euro cents, signed from RESCUE's point
of view: money in positive, money out negative, so summing the column is
always meaningful. **There is no balance column** — a balance is a fold over
entries, and a stored balance that disagrees with its entries makes neither
trustworthy.

Three moments, all driven from the outbox rather than from the request that
caused them:

- quote approved → authorise the customer for the **gross**, VAT included
- job completed → capture, then pay the provider **what they accepted**, not a
  share recomputed at payout time, which could differ from the agreement
- job cancelled before capture → release the hold; after capture it is a
  refund decision for a person, not something to do automatically

PostgreSQL enforces what the code enforces: a zero entry is refused, the sign
must agree with the kind, and `UPDATE`/`DELETE` are refused by trigger.

## 6. Maps, and the caveat it removes

The old distance model compared German postal-code prefixes. Its own comment
said it "is NOT a real road distance and must not be shown to customers as
one" — and it was still the number the eligibility gate used to include or
exclude a provider from a job.

There is now a port with both: the estimate, and OpenStreetMap. Every answer
carries `isRoadDistance`, which reaches the dispatcher's eligibility list as
`distanceIsRoad`, so a guess can never be presented as a measurement.

Distances resolve **before** ranking, not inside it, so `rankProviders` stays a
pure synchronous function of stored facts — the property the whole
deterministic gate rests on. The caching wrapper is not an optimisation: it is
how the adapter stays inside Nominatim's usage policy, which asks for caching
and at most one request a second. When the provider is unreachable the
estimate answers instead, with the flag false, so the degradation shows up
rather than being quietly presented as a road distance.

Nominatim and OSRM are keyless and open, which is why they are the ones wired:
no account, no card, no per-request cost, and the same shape as a paid
provider so swapping is a constructor change. `MAPS_PROVIDER=osm` without
`MAPS_USER_AGENT` is refused at boot, because their policy requires a
contactable agent and a generic one gets the deployment blocked.

## 7. AI

Three rules, and they are the whole design:

**Nothing leaves unvalidated.** A model's answer is parsed against the same Zod
schema the rest of the system uses. It is not coerced, not merged with
defaults, not partially accepted — an answer that does not fit is discarded and
the rules engine answers. A malformed suggestion that looks plausible is worse
than no suggestion.

**Every suggestion carries its provenance**, recorded against the job whether
or not anyone acts on it: prompt id, prompt version, model, confidence,
latency, and whether it came from the model at all. Six months from now the
only way to answer "why did it say a box van" is to know which prompt produced
it.

**Confidence changes what a person is told and nothing else.** No threshold
anywhere causes or prevents a state change.

`requiresHumanApproval` is typed `z.literal(true)`, so a model claiming it does
not need a person does not produce an overreaching suggestion — it produces an
invalid one, which is thrown away entirely. That is the strongest form of the
guarantee: it is not enforced by a check that could be removed, it is
unrepresentable.

## 8. Proving no AI output moves a job

The requirement most easily lost while adding automation, checked three ways
that do not trust each other:

**Structurally.** The test greps the source: only routes call `transitionJob`,
the AI module contains no reference to the store at all, nothing under
`worker/` mentions a transition, the sweep touches only offers and events, and
`requiresHumanApproval` is assigned the literal `true` everywhere it appears.

**Behaviourally.** Create a job, then run the worker and the sweep through
twenty-four simulated hours with nobody pressing anything. The job is still
`DRAFT`. Separately: let every offer on a quoted job lapse six times over — the
sweep re-offers and escalates and never accepts on a provider's behalf. And
every transition that did happen is checked to carry a non-null actor.

**Adversarially.** A model that is maximally confident and asserts it needs no
approval: the answer is rejected outright by the schema. A model that is
maximally confident and well-formed: the suggestion is delivered in full, the
job stays `DRAFT`, and the only event on it is `JOB_CREATED`. Certainty is
allowed; authority is not.

## 9. Running it

The worker is a second process against the same database:

```
pnpm --filter @rescue/api dev:worker
```

It is safe to run several — claims use `SKIP LOCKED` and the sweep is
idempotent. With no `DATABASE_URL` it warns loudly that it has its own copy of
the in-memory store and shares nothing with the API.

## 10. Testing

| Layer | Count | Notes |
| --- | --- | --- |
| API | 265 passing, 3 skipped | Skipped: `PrismaStore` conformance, and two live map checks |
| Web | 51 passing | Component, i18n and 28 contrast assertions |
| End-to-end | 26 passing | 13 journeys × desktop Chromium and Pixel 7 |

Migration `20260919000300` was applied to a real PostgreSQL 16 and each
constraint provoked: a duplicate dedupe key, a `SENT` row without a timestamp,
a positive payout, an update to a ledger entry, a confidence above one. All
five were refused.

## 11. Known limitations

- **`PrismaStore` is still unexecuted.** This is now the largest risk in the
  codebase: the outbox, the ledger and the suggestion table all gained Prisma
  implementations this phase, and the container cannot reach
  `binaries.prisma.sh` to run the conformance suite against them. The
  migrations are verified; the adapter code is not. Running
  `DATABASE_URL=postgresql://localhost:5432/rescue_test pnpm --filter
  @rescue/api test` on a machine with the Prisma engine would close it.
- **The maps adapter has not run against the live services from here** — this
  container's egress blocks both. Its request shape, parsing and failure
  handling are tested against a substituted transport, and a live check exists
  behind `MAPS_LIVE=1` for a machine that can reach them.
- Notifications and payments have development adapters only. Both ports are
  the shape a real provider needs; neither has been run against one.
- The worker has no metrics. Dead letters are logged at error level and
  nothing counts them, so "how many deliveries failed this week" has no answer
  yet. Phase 5.
- Dispatch escalations go to a null recipient — there is no on-call address in
  the system, so the development sender logs them.
- Offer expiry is a poll, not a scheduled wake-up. At one sweep a minute an
  offer can outlive its deadline by up to a minute, which is well inside the
  tolerance of a twenty-minute offer but would not be for a one-minute one.
