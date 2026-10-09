# Build context: repo root. Built by GitHub Actions, pulled by Dokploy.
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/indexer/package.json apps/indexer/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=dbc-radar-bun,target=/root/.bun/install/cache \
	bun install --frozen-lockfile --production --filter @dbc-radar/indexer

FROM oven/bun:1-alpine
WORKDIR /app
COPY --from=deps /app ./
COPY apps/indexer ./apps/indexer
RUN mkdir -p /data && chown bun:bun /data
ENV NODE_ENV=production \
	PORT=4000 \
	DB_PATH=/data/radar.sqlite
USER bun
WORKDIR /app/apps/indexer
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD wget -qO- http://127.0.0.1:4000/api/health > /dev/null || exit 1
CMD ["bun", "src/index.ts"]
