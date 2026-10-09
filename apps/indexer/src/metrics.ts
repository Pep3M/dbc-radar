import type {
	Candle,
	GlobalStats,
	PoolDetail,
	PoolSort,
	PoolSummary,
	RiskFlag,
	TradeRow,
} from './domain/api'
import type { PriceFeed } from './prices'
import type { Db } from './store/db'

type PoolRow = {
	pool: string
	base_mint: string | null
	quote_mint: string | null
	creator: string | null
	name: string | null
	symbol: string | null
	image: string | null
	twitter: string | null
	website: string | null
	mcap_usd: number | null
	liquidity_usd: number | null
	holders: number | null
	top10_pct: number | null
	bot_pct: number | null
	fresh_holders: number | null
	created_at: number | null
	first_seen_at: number
	last_trade_at: number | null
	last_price: number | null
	progress: number | null
	quote_reserve: number | null
	migration_threshold: number | null
	graduated_at: number | null
	trades: number
	buys: number
	sells: number
	unique_traders: number
	volume: number
	buy_volume: number
	sell_volume: number
	volume_5m: number
	sell_volume_5m: number
	buy_volume_5m: number
	top_buyer_volume: number
	creator_sold: number
}

const POOL_SELECT = `
	SELECT p.*,
		tk.name, tk.symbol, tk.image, tk.twitter, tk.website, tk.mcap_usd, tk.liquidity_usd,
		tk.holders, tk.top10_pct, tk.bot_pct, tk.fresh_holders,
		count(t.signature) AS trades,
		coalesce(sum(t.side = 'buy'), 0) AS buys,
		coalesce(sum(t.side = 'sell'), 0) AS sells,
		count(DISTINCT t.trader) AS unique_traders,
		coalesce(sum(t.usd_amount), 0) AS volume,
		coalesce(sum(CASE WHEN t.side = 'buy' THEN t.usd_amount END), 0) AS buy_volume,
		coalesce(sum(CASE WHEN t.side = 'sell' THEN t.usd_amount END), 0) AS sell_volume,
		coalesce(sum(CASE WHEN t.ts >= $since5m THEN t.usd_amount END), 0) AS volume_5m,
		coalesce(sum(CASE WHEN t.ts >= $since5m AND t.side = 'buy' THEN t.usd_amount END), 0) AS buy_volume_5m,
		coalesce(sum(CASE WHEN t.ts >= $since5m AND t.side = 'sell' THEN t.usd_amount END), 0) AS sell_volume_5m,
		coalesce((
			SELECT max(v) FROM (
				SELECT sum(usd_amount) AS v FROM trades
				WHERE pool = p.pool AND side = 'buy' GROUP BY trader
			)
		), 0) AS top_buyer_volume,
		coalesce(sum(CASE WHEN t.side = 'sell' AND t.trader = p.creator THEN t.usd_amount END), 0) AS creator_sold
	FROM pools p
	LEFT JOIN tokens tk ON tk.mint = p.base_mint
	LEFT JOIN trades t ON t.pool = p.pool
`

const assessRisk = (row: PoolRow) => {
	const flags: RiskFlag[] = []
	if (row.creator_sold > 0) flags.push('creator_sold')
	if (row.buys >= 5 && row.buy_volume > 0 && row.top_buyer_volume / row.buy_volume > 0.4)
		flags.push('whale_buyer')
	if (row.trades >= 20 && row.unique_traders / row.trades < 0.15) flags.push('wash_trading')
	if (row.sell_volume_5m > 1.5 * row.buy_volume_5m && row.sell_volume_5m > 0) flags.push('dumping')
	if (row.top10_pct !== null && (row.holders ?? 0) >= 20 && row.top10_pct > 0.5)
		flags.push('concentrated')
	if (row.fresh_holders !== null && row.fresh_holders >= 5) flags.push('fresh_wallets')
	const weights: Record<RiskFlag, number> = {
		creator_sold: 40,
		whale_buyer: 25,
		wash_trading: 20,
		dumping: 15,
		concentrated: 25,
		fresh_wallets: 15,
	}
	return {
		score: Math.min(
			flags.reduce((acc, f) => acc + weights[f], 0),
			100,
		),
		flags,
	}
}

const toSummary = (row: PoolRow): Omit<PoolSummary, 'priceUsd'> => ({
	pool: row.pool,
	baseMint: row.base_mint,
	quoteMint: row.quote_mint,
	creator: row.creator,
	name: row.name,
	symbol: row.symbol,
	image: row.image,
	twitter: row.twitter,
	website: row.website,
	mcapUsd: row.mcap_usd || null,
	liquidityUsd: row.liquidity_usd || null,
	holders: row.holders,
	top10Pct: row.top10_pct,
	botPct: row.bot_pct,
	freshHolders: row.fresh_holders,
	createdAt: row.created_at,
	firstSeenAt: row.first_seen_at,
	lastTradeAt: row.last_trade_at,
	price: row.last_price,
	progress: row.progress,
	quoteReserve: row.quote_reserve,
	migrationThreshold: row.migration_threshold,
	graduatedAt: row.graduated_at,
	timeToGraduateMs:
		row.graduated_at !== null && row.created_at !== null ? row.graduated_at - row.created_at : null,
	trades: row.trades,
	buys: row.buys,
	sells: row.sells,
	uniqueTraders: row.unique_traders,
	volume: row.volume,
	buyVolume: row.buy_volume,
	sellVolume: row.sell_volume,
	volume5m: row.volume_5m,
	topBuyerShare: row.buy_volume > 0 ? row.top_buyer_volume / row.buy_volume : 0,
	creatorSold: row.creator_sold,
	risk: assessRisk(row),
})

const ORDER_BY: Record<PoolSort, string> = {
	new: 'coalesce(p.created_at, p.first_seen_at) DESC',
	hot: 'volume_5m DESC',
	progress: 'p.progress DESC NULLS LAST',
}

export const createMetrics = (db: Db, prices: PriceFeed) => {
	const summarize = (row: PoolRow): PoolSummary => {
		const summary = toSummary(row)
		const priceUsd =
			summary.price === null ? null : prices.quoteToUsd(summary.quoteMint, summary.price)
		return { ...summary, priceUsd }
	}

	const listQuery = (order: string) =>
		db.query<PoolRow, { since5m: number; limit: number; onlyNew: number }>(
			`${POOL_SELECT}
			WHERE p.graduated_at IS NULL AND ($onlyNew = 0 OR p.created_at IS NOT NULL)
			GROUP BY p.pool ORDER BY ${order} LIMIT $limit`,
		)
	const listQueries: Record<PoolSort, ReturnType<typeof listQuery>> = {
		new: listQuery(ORDER_BY.new),
		hot: listQuery(ORDER_BY.hot),
		progress: listQuery(ORDER_BY.progress),
	}

	const oneQuery = db.query<PoolRow, { since5m: number; pool: string }>(
		`${POOL_SELECT} WHERE p.pool = $pool GROUP BY p.pool`,
	)

	const graduatedQuery = db.query<PoolRow, { since5m: number; limit: number }>(
		`${POOL_SELECT} WHERE p.graduated_at IS NOT NULL GROUP BY p.pool ORDER BY p.graduated_at DESC LIMIT $limit`,
	)

	const recentTrades = db.query<TradeRow, { pool: string; limit: number }>(
		'SELECT signature, trader, side, quote_amount, usd_amount, base_amount, price, ts FROM trades WHERE pool = $pool ORDER BY ts DESC, idx DESC LIMIT $limit',
	)

	const candles = db.query<Candle, { pool: string; bucketMs: number }>(`
		SELECT bucket,
			(SELECT price FROM trades WHERE pool = $pool AND price IS NOT NULL AND ts / $bucketMs * $bucketMs = bucket ORDER BY ts ASC LIMIT 1) AS open,
			max(price) AS high, min(price) AS low,
			(SELECT price FROM trades WHERE pool = $pool AND price IS NOT NULL AND ts / $bucketMs * $bucketMs = bucket ORDER BY ts DESC LIMIT 1) AS close,
			sum(usd_amount) AS volume
		FROM (SELECT ts / $bucketMs * $bucketMs AS bucket, price, usd_amount FROM trades WHERE pool = $pool AND price IS NOT NULL)
		GROUP BY bucket ORDER BY bucket
	`)

	const globalStats = db.query<GlobalStats, { since1h: number; since24h: number }>(`
		SELECT
			(SELECT count(*) FROM pools WHERE created_at >= $since1h) AS launches_1h,
			(SELECT count(*) FROM pools WHERE created_at >= $since24h) AS launches_24h,
			(SELECT count(*) FROM pools WHERE graduated_at >= $since24h) AS graduations_24h,
			(SELECT count(*) FROM trades WHERE ts >= $since1h) AS trades_1h,
			(SELECT coalesce(sum(usd_amount), 0) FROM trades WHERE ts >= $since1h) AS volume_1h,
			(SELECT count(DISTINCT trader) FROM trades WHERE ts >= $since1h) AS traders_1h
	`)

	return {
		listPools(sort: PoolSort, limit: number, onlyNew: boolean) {
			const since5m = Date.now() - 5 * 60_000
			return listQueries[sort].all({ since5m, limit, onlyNew: onlyNew ? 1 : 0 }).map(summarize)
		},
		listGraduated(limit: number) {
			return graduatedQuery.all({ since5m: Date.now() - 5 * 60_000, limit }).map(summarize)
		},
		getPool(pool: string): PoolDetail | null {
			const row = oneQuery.get({ since5m: Date.now() - 5 * 60_000, pool })
			if (!row) return null
			return {
				...summarize(row),
				recentTrades: recentTrades.all({ pool, limit: 50 }),
				candles: candles.all({ pool, bucketMs: 60_000 }),
			}
		},
		stats(): GlobalStats | null {
			const now = Date.now()
			return globalStats.get({ since1h: now - 3_600_000, since24h: now - 86_400_000 })
		},
	}
}

export type Metrics = ReturnType<typeof createMetrics>
