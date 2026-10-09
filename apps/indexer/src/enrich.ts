import { dataApi, type HoldersResponse } from './solami/data-api'
import type { BlurMessage } from './sources/blur'
import type { Db } from './store/db'

// Program-owned accounts that hold supply but aren't holders: the DBC curve vault authority
// and the DAMM v2 pool authority that receives liquidity on graduation.
const NON_HOLDER_OWNERS = new Set([
	'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM',
	'HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC',
])

const METADATA_INTERVAL_MS = 3_000
const METADATA_BATCH = 50
const METADATA_RETRY_MS = 120_000
const HOLDERS_INTERVAL_MS = 10_000
const HOLDERS_PER_TICK = 5
const HOLDERS_STALE_MS = 90_000
const ACTIVE_WINDOW_MS = 10 * 60_000

export const summarizeHolders = (res: HoldersResponse) => {
	const holders = res.top.filter((h) => !NON_HOLDER_OWNERS.has(h.owner))
	const locked = res.top
		.filter((h) => NON_HOLDER_OWNERS.has(h.owner))
		.reduce((acc, h) => acc + h.amount, 0)
	const circulating = res.supply - locked
	if (circulating <= 0) return { top10Pct: null, botPct: null, freshHolders: 0 }
	const share = (list: typeof holders) => list.reduce((acc, h) => acc + h.amount, 0) / circulating
	return {
		top10Pct: share(holders.slice(0, 10)),
		botPct: share(holders.filter((h) => h.tags?.includes('bot'))),
		freshHolders: holders.filter((h) => h.tags?.includes('fresh')).length,
	}
}

/**
 * Enriches pools discovered on the gRPC stream with Solami's Data API (metadata, holders)
 * and Blur (live market cap / liquidity). Runs on timers so the hot ingest path never waits
 * on HTTP.
 */
export const createEnricher = (db: Db) => {
	const stats = { metadataFetched: 0, holdersFetched: 0, blurUpdates: 0, errors: 0 }

	const upsertMetadata = db.query(`
		INSERT INTO tokens (mint, name, symbol, image, twitter, website, metadata_at)
		VALUES ($mint, $name, $symbol, $image, $twitter, $website, $now)
		ON CONFLICT (mint) DO UPDATE SET
			name = coalesce(excluded.name, name),
			symbol = coalesce(excluded.symbol, symbol),
			image = coalesce(excluded.image, image),
			twitter = coalesce(excluded.twitter, twitter),
			website = coalesce(excluded.website, website),
			metadata_at = excluded.metadata_at
	`)

	const upsertMarket = db.query(`
		INSERT INTO tokens (mint, mcap_usd, liquidity_usd, market_at)
		VALUES ($mint, $mcap, $liquidity, $now)
		ON CONFLICT (mint) DO UPDATE SET
			mcap_usd = excluded.mcap_usd, liquidity_usd = excluded.liquidity_usd, market_at = excluded.market_at
	`)

	const upsertHolders = db.query(`
		INSERT INTO tokens (mint, holders, top10_pct, bot_pct, fresh_holders, holders_at)
		VALUES ($mint, $holders, $top10Pct, $botPct, $freshHolders, $now)
		ON CONFLICT (mint) DO UPDATE SET
			holders = excluded.holders, top10_pct = excluded.top10_pct, bot_pct = excluded.bot_pct,
			fresh_holders = excluded.fresh_holders, holders_at = excluded.holders_at
	`)

	const missingMetadata = db.query<{ mint: string }, { retryBefore: number; limit: number }>(`
		SELECT DISTINCT p.base_mint AS mint FROM pools p
		LEFT JOIN tokens t ON t.mint = p.base_mint
		WHERE p.base_mint IS NOT NULL
			AND (t.metadata_at IS NULL OR (t.name IS NULL AND t.metadata_at < $retryBefore))
		ORDER BY coalesce(p.last_trade_at, p.first_seen_at) DESC
		LIMIT $limit
	`)

	const staleHolders = db.query<
		{ mint: string },
		{ activeSince: number; staleBefore: number; limit: number }
	>(`
		SELECT p.base_mint AS mint FROM pools p
		LEFT JOIN tokens t ON t.mint = p.base_mint
		WHERE p.base_mint IS NOT NULL AND p.last_trade_at >= $activeSince
			AND (t.holders_at IS NULL OR t.holders_at < $staleBefore)
		GROUP BY p.base_mint
		ORDER BY t.holders_at IS NOT NULL, max(p.progress) DESC
		LIMIT $limit
	`)

	const fetchMetadata = async () => {
		const now = Date.now()
		const mints = missingMetadata
			.all({ retryBefore: now - METADATA_RETRY_MS, limit: METADATA_BATCH })
			.map((r) => r.mint)
		if (mints.length === 0) return
		try {
			const rows = await dataApi.metadata(mints)
			const found = new Set<string>()
			for (const row of rows) {
				found.add(row.address)
				upsertMetadata.run({
					mint: row.address,
					name: row.name,
					symbol: row.symbol,
					image: row.image,
					twitter: row.socials?.x ?? null,
					website: row.socials?.website ?? null,
					now,
				})
			}
			// Remember misses so brand-new mints are retried later instead of on every tick.
			for (const mint of mints.filter((m) => !found.has(m))) {
				upsertMetadata.run({
					mint,
					name: null,
					symbol: null,
					image: null,
					twitter: null,
					website: null,
					now,
				})
			}
			stats.metadataFetched += rows.length
		} catch (error) {
			stats.errors++
			console.warn('[enrich] metadata:', (error as Error).message)
		}
	}

	const fetchHolders = async () => {
		const now = Date.now()
		const mints = staleHolders.all({
			activeSince: now - ACTIVE_WINDOW_MS,
			staleBefore: now - HOLDERS_STALE_MS,
			limit: HOLDERS_PER_TICK,
		})
		for (const { mint } of mints) {
			try {
				const res = await dataApi.holders(mint)
				upsertHolders.run({ mint, holders: res.holders, ...summarizeHolders(res), now: Date.now() })
				stats.holdersFetched++
			} catch (error) {
				stats.errors++
				console.warn(`[enrich] holders ${mint}:`, (error as Error).message)
			}
		}
	}

	const timers: ReturnType<typeof setInterval>[] = []

	return {
		stats,
		handleBlur(message: BlurMessage) {
			if (message.type === 'metadata') {
				const m = message as Extract<BlurMessage, { type: 'metadata' }>
				upsertMetadata.run({
					mint: m.mint,
					name: m.name,
					symbol: m.symbol,
					image: m.logo_uri ?? null,
					twitter: m.socials?.x ?? null,
					website: m.socials?.website ?? null,
					now: Date.now(),
				})
				stats.blurUpdates++
			} else if (message.type === 'token_update') {
				const m = message as Extract<BlurMessage, { type: 'token_update' }>
				upsertMarket.run({
					mint: m.mint,
					mcap: Number(m.mcap_usd),
					liquidity: Number(m.liquidity_usd),
					now: Date.now(),
				})
				stats.blurUpdates++
			}
		},
		start() {
			timers.push(setInterval(fetchMetadata, METADATA_INTERVAL_MS))
			timers.push(setInterval(fetchHolders, HOLDERS_INTERVAL_MS))
		},
		stop() {
			for (const timer of timers) clearInterval(timer)
		},
	}
}

export type Enricher = ReturnType<typeof createEnricher>
