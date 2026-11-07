FROM node:26.11.1-bookworm-slim@sha256:86f07bc9c5dce4578cf37e5a418b7bfc7f817cda25cde66e2b66e95ed86c4567 AS base
WORKDIR /app
RUN npm install --global bun@1.4.1
COPY . .
RUN node -e 'if(process.versions.node!=="26.11.1")process.exit(1)' && bun install --frozen-lockfile
RUN bun run build
FROM base AS web
EXPOSE 3000
CMD ["node", "apps/web/node_modules/next/dist/bin/next", "start", "apps/web", "--hostname", "0.0.0.0"]
FROM base AS worker
CMD ["node", "apps/worker/dist/index.ts"]
