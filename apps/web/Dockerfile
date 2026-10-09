# Build context: repo root. Built by GitHub Actions, pulled by Dokploy.
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/indexer/package.json apps/indexer/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=dbc-radar-bun,target=/root/.bun/install/cache \
	bun install --frozen-lockfile --filter @dbc-radar/web

FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY --from=deps /app ./
# The web app only imports types from the indexer package.
COPY apps/indexer/src/domain apps/indexer/src/domain
COPY apps/indexer/src/public-types.ts apps/indexer/src/
COPY apps/web apps/web
# basePath and the rewrite target are baked into the build.
ARG BASE_PATH=/dbc-radar
ARG INDEXER_URL=http://indexer:4000
ENV BASE_PATH=${BASE_PATH} \
	INDEXER_URL=${INDEXER_URL} \
	NEXT_TELEMETRY_DISABLED=1 \
	NODE_ENV=production
WORKDIR /app/apps/web
RUN bun --bun next build

FROM oven/bun:1-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production \
	NEXT_TELEMETRY_DISABLED=1 \
	PORT=3000 \
	HOSTNAME=0.0.0.0
COPY --from=builder --chown=bun:bun /app/apps/web/.next/standalone ./
COPY --from=builder --chown=bun:bun /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=bun:bun /app/apps/web/public ./apps/web/public
USER bun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD wget -qO- http://127.0.0.1:3000/dbc-radar > /dev/null || exit 1
CMD ["bun", "apps/web/server.js"]
