# Claude Audit and Build Instructions

Copy the prompt below into Claude Code from the repository root.

---

You are the senior engineer and security reviewer for RESCUE Circular Logistics, a German B2B exception-logistics platform. Work directly in this repository. Preserve the product boundary: failed bulky deliveries, bulky returns and reusable company surplus. Hazardous waste is excluded.

## Operating rules

1. Inspect the repository before changing files.
2. Read `README.md`, `docs/ARCHITECTURE.md`, the Prisma schema and shared contracts completely.
3. Run the existing checks and record failures before modifying code.
4. Create a new Git branch named `claude/audit-foundation`.
5. Never commit secrets, `.env`, private keys, production data or real customer information.
6. Make small, reviewable commits after every completed phase.
7. Do not replace working architecture without documenting the reason in an ADR.
8. AI recommendations must remain advisory and human-approved.
9. Treat tenant isolation, provider eligibility, monetary integrity, audit logs and idempotency as security-critical.
10. Stop and report if a requested integration requires credentials that are not already configured.

## Phase 1 - Audit only

Do not edit code yet.

- Map packages, dependency boundaries and request flow.
- Run `pnpm install`, `pnpm db:generate`, `pnpm typecheck`, `pnpm test` and `pnpm build`.
- Review for broken builds, unsafe defaults, tenant-ID spoofing, missing authentication, mass assignment, injection, SSRF, unrestricted uploads, PII leakage, weak error handling and supply-chain risk.
- Produce `docs/audits/FOUNDATION_AUDIT.md` with findings ranked Critical, High, Medium and Low.
- For every finding include file, evidence, exploit/failure scenario and exact remediation.
- Do not claim a security property that is not enforced by code.

Commit only the audit:

```bash
git add docs/audits/FOUNDATION_AUDIT.md
git commit -m "docs: audit foundation architecture and security"
```

## Phase 2 - Backend foundation

Implement in this order:

1. OIDC-compatible authentication abstraction and test identity provider.
2. Organisation membership and role-based authorisation.
3. Replace the in-memory repository with Prisma/PostgreSQL.
4. Add idempotency keys for job creation and later mutations.
5. Implement provider, vehicle and compliance-document endpoints.
6. Implement deterministic provider eligibility.
7. Add quote creation and customer approval using integer euro cents.
8. Add assignment offers, expiry, acceptance and fallback transitions.
9. Add immutable job events and audit logs in the same transaction as mutations.
10. Add signed evidence-upload requests with allowlisted MIME types and size limits.

For every endpoint add:

- Zod validation
- tenant and role checks
- success and error contracts
- unit tests
- API integration tests
- audit events
- OpenAPI documentation

Do not integrate a live payment or AI provider in this phase. Use interfaces and deterministic fakes.

Verification and commit:

```bash
pnpm check
git add apps/api packages/contracts packages/database docs
git commit -m "feat(api): add secure multi-tenant logistics foundation"
```

## Phase 3 - Frontend foundation

Build role-specific flows:

- Customer: create request, review assessment, approve quote, track job and download proof.
- Provider: complete onboarding, manage vehicles/documents, set availability, accept offers and submit evidence.
- Dispatcher: triage queue, human approval, provider eligibility, fallback, incident and audit timeline.

Requirements:

- Server-side session enforcement
- No tenant ID accepted from editable form state
- Accessible keyboard navigation and WCAG-aware contrast
- German and English translation structure
- Empty, loading, error and retry states
- Mobile-responsive design
- No sensitive data stored in localStorage
- Component and end-to-end tests for critical workflows

Verification and commit:

```bash
pnpm check
git add apps/web packages/contracts
git commit -m "feat(web): add customer provider and dispatch workflows"
```

## Phase 4 - Async operations and integrations

- Add an outbox table and worker process.
- Implement provider-offer expiry and automatic fallback.
- Add notification adapters with a log-only development provider.
- Add payment interfaces for authorisation, capture, payout and refund ledger entries.
- Add maps interfaces for geocoding, distance and ETA.
- Add AI interface that returns schema-validated suggestions, prompt/version metadata and confidence.
- Ensure no AI output changes job state without a human action.

Commit:

```bash
pnpm check
git add .
git commit -m "feat(platform): add async dispatch and integration adapters"
```

## Phase 5 - Production readiness

- Add migration deployment strategy and seed data limited to synthetic development records.
- Add structured logs, correlation IDs, metrics and health/readiness probes.
- Add backup, restore and incident runbooks.
- Add dependency scanning, secret scanning and container scanning in GitHub Actions.
- Add GDPR data inventory, retention schedule, subject-access and deletion design.
- Add threat model covering customer, provider, dispatcher, integration and administrator boundaries.
- Add load tests for quote bursts and provider-offer fan-out.

Final verification:

```bash
pnpm check
git status
git log --oneline --decorate -10
```

Produce `docs/audits/RELEASE_READINESS.md`. Clearly list incomplete work and never mark the system production-ready while Critical or High findings remain.

Final commit:

```bash
git add .
git commit -m "chore: complete release readiness controls"
```

## Required final response

Report:

1. Architecture changes
2. Security findings fixed and still open
3. Database migrations
4. API and UI functionality added
5. Test/build results
6. Commits created
7. Exact environment variables still required
8. Steps the founder must complete before production

---
