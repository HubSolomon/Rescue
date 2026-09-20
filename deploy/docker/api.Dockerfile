# The API, and the worker: one image, two entrypoints.
#
# They share every line of code and differ only in which file node starts, so
# building two images would mean building the same thing twice and then having
# to remember to deploy both when either changes. The image defaults to the
# API; the worker is `command: ["node", "dist/worker/main.js"]`.
#
# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- deps
# Split from the build so a source-only change reuses the install layer. The
# lockfile and the manifests are the only inputs, so they are the only things
# copied in.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json          apps/api/
COPY apps/web/package.json          apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/database/package.json  packages/database/

# --frozen-lockfile, so a lockfile that drifted from the manifests fails the
# build rather than resolving to something nobody tested.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# --------------------------------------------------------------- build
FROM deps AS build
WORKDIR /app
COPY . .
# Generates the Prisma client, builds the contracts package, then the API.
RUN pnpm --filter @rescue/contracts build \
 && pnpm --filter @rescue/database build \
 && pnpm --filter @rescue/api build

# Drops every devDependency from the tree that ships.
#
# `--config.inject-workspace-packages=true` is load-bearing, not a style
# choice. Without it pnpm links the workspace packages by relative path OUT of
# the deploy directory -- verified here: the plain form produced
# `@rescue/contracts -> ../../../../home/claude/rescue/packages/contracts`,
# which copies into the image as a dangling symlink and fails on the first
# import. Injected, the packages are copied in and the links stay inside.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @rescue/api --prod --config.inject-workspace-packages=true deploy /pruned

# --------------------------------------------------------------- runtime
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

# openssl: the Prisma query engine links against it and the slim image has no
# copy. Without this the container starts and fails on its first query, which
# is a far more expensive way to discover a missing shared library.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
# Containers publish; the default is loopback so `pnpm dev` never does.
ENV API_HOST=0.0.0.0
ENV API_PORT=4000
ENV WORKER_METRICS_PORT=4001

# One copy. The pruned tree is complete, including the generated Prisma client.
#
# It did not used to be. This file previously carried two further COPY lines
# that pulled `/app/node_modules/.prisma` and the schema in separately, and
# both were wrong: under pnpm the default generator output lands in
# `node_modules/.pnpm/@prisma+client@<version>_<peer hash>/node_modules/.prisma`,
# so `/app/node_modules/.prisma` does not exist and the build fails on the COPY
# -- and had it existed, `pnpm deploy` had already written a placeholder client
# into the pruned tree at the path the runtime actually resolves, so the image
# would have started and thrown "did not initialize yet" on the first query.
#
# The fix is in `packages/database/prisma/schema.prisma`: an explicit generator
# `output` inside the package, which the deploy carries like any other file.
# Verified by pruning and loading `@rescue/database` out of the result.
COPY --from=build --chown=node:node /pruned ./

# node, not root. The image installs nothing at runtime and writes nothing to
# disk, so there is no reason for it to be able to.
USER node
EXPOSE 4000 4001

# Liveness only. /ready checks the database, and an orchestrator that restarts
# a healthy process because Postgres blinked turns a brief dependency outage
# into a restart loop.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
