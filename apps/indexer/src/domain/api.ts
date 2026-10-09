/** Types shared with the web app. Keep this file free of runtime imports. */

export type LiveEvent =
	| { type: 'pool_created'; pool: string; baseMint: string; creator: string; ts: number }
	| {
			type: 'trade'
			pool: string
			side: 'buy' | 'sell'
			trader: string
			quoteAmount: number
			usdAmount: number | null
			price: number | null
			progress: number | null
			ts: number
	  }
	| { type: 'graduated'; pool: string; ts: number }

export type RiskFlag = 'creator_sold' | 'whale_buyer' | 'wash_trading' | 'dumping'

export type PoolSummary = {
	pool: string
	baseMint: string | null
	quoteMint: string | null
	creator: string | null
	name: string | null
	symbol: string | null
	createdAt: number | null
	firstSeenAt: number
	lastTradeAt: number | null
	price: number | null
	priceUsd: number | null
	progress: number | null
	quoteReserve: number | null
	migrationThreshold: number | null
	graduatedAt: number | null
	trades: number
	buys: number
	sells: number
	uniqueTraders: number
	volume: number
	buyVolume: number
	sellVolume: number
	volume5m: number
	topBuyerShare: number
	creatorSold: number
	risk: { score: number; flags: RiskFlag[] }
}

export type PoolSort = 'new' | 'hot' | 'progress'

export type TradeRow = {
	signature: string
	trader: string
	side: 'buy' | 'sell'
	quote_amount: number
	usd_amount: number | null
	base_amount: number
	price: number | null
	ts: number
}

export type Candle = {
	bucket: number
	open: number
	high: number
	low: number
	close: number
	volume: number
}

export type PoolDetail = PoolSummary & { recentTrades: TradeRow[]; candles: Candle[] }

export type GlobalStats = {
	launches_1h: number
	launches_24h: number
	graduations_24h: number
	trades_1h: number
	volume_1h: number
	traders_1h: number
}

export type Health = {
	source: string
	sourceStats?: Record<string, number>
	txs: number
	events: number
	lastEventAt: number
	lastEventAgeMs: number | null
	startedAt: number
	uptimeMs: number
}
