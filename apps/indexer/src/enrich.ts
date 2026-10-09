import { KNOWN_QUOTE_MINTS } from './dbc-configs'
import type { HolderTag, TopHolder } from './domain/api'
import { dataApi, type HoldersResponse } from './solami/data-api'
import type { BlurGraduated, BlurMessage } from './sources/blur'
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
const TOP_HOLDERS = 12
// Candidate field names for the new pool in Blur's `graduated` message.
const GRADUATED_POOL_KEYS = [
	'damm_pool',
	'new_pool',
	'migrated_pool',
	'target_pool',
	'pool_address',
]

export const summarizeHolders = (res: HoldersResponse) => {
	const holders = res.top.filter((h) => !NON_HOLDER_OWNERS.has(h.owner))
	const locked = res.top
		.filter((h) => NON_HOLDER_OWNERS.has(h.owner))
		.reduce((acc, h) => acc + h.amount, 0)
	// The holders list can disagree with `supply` (stale snapshot, duplicate accounts); never let
	// shares exceed 100%.
	const circulating = Math.max(
		res.supply - locked,
		holders.reduce((acc, h) => acc + h.amount, 0),
	)
	if (circulating <= 0) return { top10Pct: null, botPct: null, freshHolders: 0, top: [] }
	const share = (list: typeof holders) => list.reduce((acc, h) => acc + h.amount, 0) / circulating
	// The 'creator' tag is added at read time, where the pool's creator is known.
	const top: TopHolder[] = holders.slice(0, TOP_HOLDERS).map((h) => ({
		address: h.owner,
		pct: h.amount / circulating,
		tags: (['fresh', 'bot'] as HolderTag[]).filter((t) => h.tags?.includes(t)),
	}))
	return {
		top10Pct: share(holders.slice(0, 10)),
		botPct: share(holders.filter((h) => h.tags?.includes('bot'))),
		freshHolders: holders.filter((h) => h.tags?.includes('fresh')).length,
		top,
	}
}

/**
 * Enriches pools discovered on the gRPC stream with Solami's Data API (metadata, holders)
 * and Blur (live market cap / liquidity). Runs on timers so the hot ingest path never waits
 * on HTTP.
 */
// Token creators pick their own names; bidi overrides (U+202E…) would reverse the text around
// them wherever the name is rendered, so strip direction controls before storing.
const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
const cleanText = (value: string | null | undefined) => {
	const text = value?.replace(BIDI_CONTROLS, '').trim()
	return text ? text : null
}

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
		INSERT INTO tokens (mint, holders, top10_pct, bot_pct, fresh_holders, holders_top, holders_at)
		VALUES ($mint, $holders, $top10Pct, $botPct, $freshHolders, $top, $now)
		ON CONFLICT (mint) DO UPDATE SET
			holders = excluded.holders, top10_pct = excluded.top10_pct, bot_pct = excluded.bot_pct,
			fresh_holders = excluded.fresh_holders, holders_top = excluded.holders_top,
			holders_at = excluded.holders_at
	`)

	const setDammPool = db.query(
		'UPDATE pools SET damm_pool = $dammPool WHERE pool = $pool OR base_mint = $mint',
	)

	// Base mints, plus non-standard quote mints (so their symbol can label the pair).
	const missingMetadata = db.query<
		{ mint: string },
		{ retryBefore: number; limit: number; known: string }
	>(`
		SELECT m.mint FROM (
			SELECT p.base_mint AS mint, max(coalesce(p.last_trade_at, p.first_seen_at)) AS seen FROM pools p
			WHERE p.base_mint IS NOT NULL GROUP BY p.base_mint
			UNION ALL
			SELECT p.quote_mint, max(coalesce(p.last_trade_at, p.first_seen_at)) FROM pools p
			WHERE p.quote_mint IS NOT NULL AND instr($known, p.quote_mint) = 0 GROUP BY p.quote_mint
		) m
		LEFT JOIN tokens t ON t.mint = m.mint
		WHERE t.metadata_at IS NULL OR (t.name IS NULL AND t.metadata_at < $retryBefore)
		ORDER BY seen DESC
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
			.all({
				retryBefore: now - METADATA_RETRY_MS,
				limit: METADATA_BATCH,
				known: [...KNOWN_QUOTE_MINTS].join(','),
			})
			.map((r) => r.mint)
		if (mints.length === 0) return
		try {
			const rows = await dataApi.metadata(mints)
			const found = new Set<string>()
			for (const row of rows) {
				found.add(row.address)
				upsertMetadata.run({
					mint: row.address,
					name: cleanText(row.name),
					symbol: cleanText(row.symbol),
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
				const { top, ...summary } = summarizeHolders(res)
				upsertHolders.run({
					mint,
					holders: res.holders,
					...summary,
					top: JSON.stringify(top),
					now: Date.now(),
				})
				stats.holdersFetched++
			} catch (error) {
				stats.errors++
				console.warn(`[enrich] holders ${mint}:`, (error as Error).message)
			}
		}
	}

	const timers: ReturnType<typeof setInterval>[] = []
	let loggedGraduatedShape = false

	return {
		stats,
		handleBlur(message: BlurMessage) {
			if (message.type === 'metadata') {
				const m = message as Extract<BlurMessage, { type: 'metadata' }>
				upsertMetadata.run({
					mint: m.mint,
					name: cleanText(m.name),
					symbol: cleanText(m.symbol),
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
			} else if (message.type === 'graduated') {
				const m = message as BlurGraduated
				// Field names only (values may carry URLs): helps pin down the undocumented shape.
				if (!loggedGraduatedShape) {
					loggedGraduatedShape = true
					console.log('[blur] graduated message fields:', Object.keys(m).join(','))
				}
				const key = GRADUATED_POOL_KEYS.find((k) => typeof m[k] === 'string')
				if (key) {
					setDammPool.run({ dammPool: m[key] as string, pool: m.pool ?? '', mint: m.mint ?? '' })
					stats.blurUpdates++
				}
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
