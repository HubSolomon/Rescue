# RESCUE Circular Logistics

AI-assisted B2B exception logistics for failed bulky deliveries, returns and reusable company surplus.

## Repository

- `apps/web`: Next.js customer and operations interface
- `apps/api`: Fastify REST API
- `packages/contracts`: shared Zod request/response contracts
- `packages/database`: Prisma schema and database client
- `docs/ARCHITECTURE.md`: system architecture and trust boundaries
- `docs/CLAUDE_BUILD_AND_AUDIT_PROMPT.md`: staged instructions for Claude

## Local setup

```bash
cp .env.example .env
docker compose up -d
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
```

Open `http://localhost:3000`. The API health endpoint is `http://localhost:4000/v1/health`.

## Verification

```bash
pnpm check
```

## Security boundary

AI may suggest item classifications, vehicle requirements and providers. It must never independently approve hazardous materials, determine legal waste status, settle claims or bypass provider eligibility rules. Those decisions require deterministic validation and human approval.

## GitHub

Create an empty GitHub repository, then:

```bash
git remote add origin git@github.com:YOUR_ACCOUNT/rescue-circular-logistics.git
git branch -M main
git push -u origin main
```

Never commit `.env` or credentials.
