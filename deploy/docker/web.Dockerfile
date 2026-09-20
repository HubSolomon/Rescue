# The web app.
#
# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json          apps/api/
COPY apps/web/package.json          apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/database/package.json  packages/database/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
WORKDIR /app
COPY . .
# NEXT_PUBLIC_* values are inlined at build time, not read at boot, so the
# public API URL has to be a build argument. Getting this wrong produces an
# image that works on the machine that built it and calls localhost everywhere
# else.
ARG NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @rescue/contracts build \
 && pnpm --filter @rescue/web build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# The traced standalone output plus the two directories tracing does not
# include, because nothing imports them: the static chunks and public/.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public

USER node
EXPOSE 3000

# /healthz, not /de. A page render is a check of the API as much as of this
# process -- it fetches jobs -- so an API outage would mark a working web
# container unhealthy and have the orchestrator restart it in a loop. /healthz
# answers only whether this process is serving, and is exempt from the demo
# gate, which would otherwise 401 the probe.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Standalone emits a server.js at the traced workspace root.
CMD ["node", "apps/web/server.js"]
