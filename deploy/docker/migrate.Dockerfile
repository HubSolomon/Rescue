# Migrations, as a job that runs to completion and exits.
#
# Deliberately not part of the API's startup. Two API replicas booting at once
# would race `migrate deploy` against each other, and the loser's error is
# indistinguishable from a broken deployment. Worse, a migration that fails at
# boot leaves an orchestrator restart-looping a container whose real problem is
# in the database.
#
# So: run this to completion, check it exited 0, then roll the app. Every
# migration in this repository is additive, so the old image keeps working
# against the new schema during the roll -- which is what makes that order
# safe rather than merely conventional.
#
# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim
WORKDIR /app
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable \
 && apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/database/package.json packages/database/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @rescue/database

COPY packages/database ./packages/database
RUN pnpm --filter @rescue/database exec prisma generate

USER node
# `deploy`, never `dev`: `migrate dev` can reset the database.
CMD ["pnpm", "--filter", "@rescue/database", "exec", "prisma", "migrate", "deploy"]
