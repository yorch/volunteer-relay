FROM node:26.11.1-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567 AS node
WORKDIR /app

# Shared tooling for every install stage. Bun is pinned here once; the optional
# proxy CA is only read from the build secret and is never persisted.
FROM node AS tooling
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    npm install --global bun@1.4.1

# Install layers depend only on the root manifest, the lockfile and the
# workspace manifests, so source edits do not invalidate the dependency layer.
# Keep this list in sync with the workspaces in the root package.json.
FROM tooling AS build
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/ai/package.json packages/ai/
COPY packages/blob/package.json packages/blob/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/intake/package.json packages/intake/
COPY packages/notifications/package.json packages/notifications/
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    node -e 'if(process.versions.node!=="26.11.1")process.exit(1)' && bun install --frozen-lockfile
COPY . .
RUN bun run build

# Local development topology (Compose); not published. Runs next dev as the
# node user, so the web app sources and build output must be writable (dev
# rewrites generated files such as next-env.d.ts) while dependencies stay
# root-owned.
FROM build AS dev
RUN mkdir -p /data/attachments \
  && chown node:node /data/attachments \
  && find apps/web -path apps/web/node_modules -prune -o -exec chown node:node {} +
USER node
CMD ["node", "apps/web/node_modules/next/dist/bin/next", "dev", "apps/web", "--hostname", "0.0.0.0"]

# Production-scoped worker dependency install: only the manifests feed the
# install layer, then the worker sources are copied and test files are pruned
# so they never reach the worker image.
FROM tooling AS worker-deps
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/ai/package.json packages/ai/
COPY packages/blob/package.json packages/blob/
COPY packages/config/package.json packages/config/
COPY packages/contracts/package.json packages/contracts/
COPY packages/db/package.json packages/db/
COPY packages/domain/package.json packages/domain/
COPY packages/intake/package.json packages/intake/
COPY packages/notifications/package.json packages/notifications/
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca SSL_CERT_FILE=/run/secrets/proxy_ca; fi; \
    bun install --frozen-lockfile --production --filter @relay/worker
COPY apps/worker apps/worker
COPY packages packages
COPY scripts/retention.ts scripts/provision-organization.ts scripts/live-provider-smoke.ts scripts/
RUN find apps/worker packages -type f -name '*.test.ts' -not -path '*/node_modules/*' -print -delete

# Minimal production base: node only, no bun, no sources. Only the private
# attachment volume is writable; everything else stays root-owned.
FROM node AS runtime
ENV NODE_ENV=production
ENV NODE_USE_ENV_PROXY=1
RUN mkdir -p /data/attachments && chown node:node /data/attachments

FROM runtime AS web
COPY --from=build /app/apps/web/.next/standalone/ /app/
COPY --from=build /app/apps/web/.next/static/ /app/apps/web/.next/static/
RUN chown -R node:node /app/apps/web/.next
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
USER node
EXPOSE 3000
CMD ["node", "apps/web/server.js"]

FROM runtime AS worker
COPY --from=worker-deps /app/node_modules /app/node_modules
COPY --from=worker-deps /app/package.json /app/package.json
COPY --from=worker-deps /app/apps/worker /app/apps/worker
COPY --from=worker-deps /app/packages /app/packages
COPY --from=worker-deps /app/scripts/retention.ts /app/scripts/provision-organization.ts /app/scripts/live-provider-smoke.ts /app/scripts/
RUN chmod -R a+rX /app/apps/worker /app/packages /app/scripts
USER node
CMD ["node", "apps/worker/src/index.ts"]
