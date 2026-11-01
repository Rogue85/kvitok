# syntax=docker/dockerfile:1
# Production image: the API with the built web interface, the queue worker, migrations and the CLI.
# One image for every process; the command picks the mode (see docker/entrypoint.sh and docs/deployment.md).

FROM node:26-bookworm-slim AS base
# openssl — for the Prisma schema engine (migrate).
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

FROM base AS build
# A store per architecture: two platforms built at once must not write into one store.
ARG TARGETARCH
# The pnpm version comes from packageManager. Node 25+ ships without corepack, so install it with npm.
COPY package.json /tmp/package.json
RUN npm install -g "$(node -p "require('/tmp/package.json').packageManager")" && rm /tmp/package.json
WORKDIR /src
# prisma.config.ts requires DATABASE_URL even for `prisma generate`, which never connects. Build stage only.
ENV CI=true \
    DATABASE_URL=postgresql://build@localhost/build
# Dependencies are fetched by the lockfile alone, so this layer survives code changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store-$TARGETARCH,target=/pnpm-store pnpm fetch --store-dir /pnpm-store
COPY . .
RUN --mount=type=cache,id=pnpm-store-$TARGETARCH,target=/pnpm-store pnpm install --offline --frozen-lockfile --store-dir /pnpm-store
RUN pnpm --filter @kvitok/api build && pnpm --filter @kvitok/web generate
# The API with production dependencies only, the workspace packages included.
RUN --mount=type=cache,id=pnpm-store-$TARGETARCH,target=/pnpm-store pnpm --filter @kvitok/api deploy --prod --legacy --store-dir /pnpm-store /out

FROM base
# The release the image is built from: CI passes 0.2.0 for a tag and edge-<sha> for main.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION \
    NODE_ENV=production \
    PORT=3001 \
    WEB_DIR=/app/web \
    STORAGE_DIR=/data/storage \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1
WORKDIR /app
COPY --from=build /out /app
COPY --from=build /src/apps/web/.output/public /app/web
COPY docker/entrypoint.sh /usr/local/bin/kvitok
# A named volume mounted here takes over this owner.
RUN mkdir -p /data/storage && chown node:node /data/storage
USER node
EXPOSE 3001
ENTRYPOINT ["kvitok"]
CMD ["api"]
