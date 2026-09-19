# ADR 0001 — Provider fallback returns a job to QUOTED, not TRIAGED

**Status:** Accepted
**Date:** 2026-09-19
**Supersedes:** the `ASSIGNED --> TRIAGED: provider fallback` edge in `docs/ARCHITECTURE.md`

## Context

The state diagram in `docs/ARCHITECTURE.md` sends a job back to `TRIAGED` when
an assigned provider falls through, and makes `ASSIGNED` reachable only from
`QUOTED`.

Those two rules cannot both hold. A job that falls back to `TRIAGED` must pass
through `QUOTED` again before it can be assigned to anyone else, which means
re-quoting a customer who has already approved a price for work that has not
changed. The first implementation of the offer flow worked around this by
allowing offers from `TRIAGED` as well as `QUOTED`, which opened a worse hole:
a job could reach `ASSIGNED` — and a provider could be dispatched and owed a
payout — with no approved quote behind it at all.

This surfaced as a failing test. Two providers accepting the same offer
concurrently both received 409 instead of one 200 and one 409, because the
underlying job sat in `TRIAGED` and `TRIAGED -> ASSIGNED` is not a legal edge.
The race handling was correct; the state machine was not.

## Decision

Provider fallback returns the job to `QUOTED`.

- `ASSIGNED -> QUOTED` and `IN_PROGRESS -> QUOTED` replace the transitions to
  `TRIAGED`.
- `QUOTED` remains the only state from which `ASSIGNED` is reachable.
- Creating offers requires the job to be `QUOTED` **and** to have an `APPROVED`
  quote. Both are checked at fan-out, not just at the first attempt.

## Consequences

**Good.** No job can be dispatched without a price the customer approved — the
invariant is now structural rather than a matter of calling the endpoints in
the right order. Re-offering after a fallback does not disturb the customer.
The quote remains the single record of what was agreed, so the commercial trail
survives any number of provider changes.

**Costs.** A fallback that genuinely invalidates the original price — the
provider discovers three flights of stairs nobody mentioned — needs an explicit
re-triage path back to `TRIAGED`. That path is not implemented yet and is
recorded as follow-up work; today such a job must be cancelled and recreated.

`docs/ARCHITECTURE.md` still shows the original edge. It is updated in the same
change that introduces this record, and this ADR is the reason.

## Alternatives considered

**Keep fallback to `TRIAGED` and allow `TRIAGED -> ASSIGNED`.** Matches the
original diagram with one added edge, but permits assignment without an
approved quote. Rejected: monetary integrity is listed as security-critical in
the build instructions, and this would make the guarantee depend on endpoints
being called in the right order rather than on the state machine.

**Introduce a distinct `AWAITING_PROVIDER` state.** Cleanest conceptually, and
would make dispatch dashboards easier to read. Rejected for now as a larger
change than the defect warrants; `QUOTED` carries the same meaning, and the
extra state can be added later without changing the monetary guarantee.
