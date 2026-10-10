/** Types shared with the web app. Keep this file free of runtime imports. */

export type LiveEvent = LiveEventBody & {
	/**
	 * Events decoded from a tx: the server's wall-clock ms when it first saw the tx's slot
	 * (same reference as /api/pipeline). Browsers subtract it from their offset-corrected
	 * clock (see /api/time) to measure slot → receive → paint on their side.
	 */
	slotAt?: number
}

type LiveEventBody =
	| {
			type: 'pool_created'
			pool: string
			baseMint: string
			creator: string
			/** Usually null: metadata lands a few seconds after creation. */
			symbol: string | null
			ts: number
	  }
	| {
			type: 'trade'
			pool: string
			symbol: string | null
			side: 'buy' | 'sell'
			trader: string
			quoteAmount: number
			usdAmount: number | null
			price: number | null
			progress: number | null
			ts: number
	  }
	| { type: 'graduated'; pool: string; ts: number }
	/** A pool newly raised a risk flag (score is the pool's score after raising it). */
	| { type: 'risk'; pool: string; symbol: string | null; flag: RiskFlag; score: number; ts: number }
	/** An alert rule fired (sent once, when recorded; `deliveries` is empty at that point). */
	| { type: 'alert'; alert: AlertFired }

export type RiskFlag =
	| 'creator_sold'
	| 'whale_buyer'
	| 'wash_trading'
	| 'dumping'
	| 'concentrated'
	| 'fresh_wallets'

export type PoolSummary = {
	pool: string
	baseMint: string | null
	quoteMint: string | null
	/** 'SOL' | 'USDC' | 'USD1' | 'USDT' | … from the quote mint; null when unknown. */
	quoteSymbol: string | null
	/** Launchpad display name ('Bags.fm', 'Moonshot', 'Jup Studio', 'ant.fun', …); null when unknown. */
	launchpad: string | null
	creator: string | null
	name: string | null
	symbol: string | null
	image: string | null
	twitter: string | null
	website: string | null
	mcapUsd: number | null
	liquidityUsd: number | null
	holders: number | null
	top10Pct: number | null
	botPct: number | null
	freshHolders: number | null
	createdAt: number | null
	firstSeenAt: number
	lastTradeAt: number | null
	price: number | null
	priceUsd: number | null
	progress: number | null
	quoteReserve: number | null
	migrationThreshold: number | null
	graduatedAt: number | null
	timeToGraduateMs: number | null
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
	/** Quote reserve after the swap (quote units), from EvtSwap2; null for rows stored before it was tracked. */
	quote_reserve: number | null
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

export type HolderTag = 'creator' | 'fresh' | 'bot'

/** `pct` is a 0..1 share of circulating supply (curve / DAMM vaults excluded). */
export type TopHolder = { address: string; pct: number; tags: HolderTag[] }

/** `bucket` is the bucket start (ms epoch). */
export type FlowBucket = { bucket: number; buyUsd: number; sellUsd: number }

/** Price (quote per base token) as a function of quote reserve (quote units). */
export type CurvePoint = { quoteReserve: number; price: number }

export type PoolDetail = PoolSummary & {
	recentTrades: TradeRow[]
	candles: Candle[]
	/** Top ~12 holders, vaults excluded; empty until the Data API has been polled for this mint. */
	holdersTop: TopHolder[]
	/** Last 5 minutes in 10 s buckets (30 entries, zero-filled). */
	flow5m: FlowBucket[]
	/** Last hour in 1 min buckets (60 entries, zero-filled). */
	flow1h: FlowBucket[]
	/** ~64 samples from 0 to migrationThreshold of the pool's real DBC curve; null if the config isn't loaded yet. */
	curve: CurvePoint[] | null
	/**
	 * Graduated pools only: the DAMM v2 pool the curve migrates into (Blur `graduated` if seen,
	 * else derived as a PDA from the config's migration fee option + mints). Null for DAMM v1.
	 */
	dammPool: string | null
}

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
	components?: Record<string, Record<string, number>>
	txs: number
	events: number
	lastEventAt: number
	lastEventAgeMs: number | null
	startedAt: number
	uptimeMs: number
}

/**
 * "Under the hood" live metrics. Every rate is a trailing 60 s window; every p50 is over the
 * last ~200 samples. Latencies are measured inside this process (no clock sync with the chain):
 * - grpc.latencyP50Ms: tx arrival minus the moment this process first saw that slot on the
 *   same Yellowstone stream (any slot status, inter-slot updates included). With the tx
 *   stream at CONFIRMED commitment this is mostly confirmation delay + delivery.
 * - blur.latencyP50Ms: Blur swap arrival minus that same slot reference, matched by
 *   signature with the gRPC copy (so the two numbers are directly comparable).
 * - dataApi.latencyP50Ms: HTTP round trip of Data API requests.
 * - indexer.processP50Ms: decode + SQLite write + in-process fan-out time per tx with events.
 * - sse.slotToPushP50Ms: SSE push time minus slot reference (server side; excludes the
 *   network hop to the browser and rendering, which each browser measures itself from
 *   `LiveEvent.slotAt`).
 */
export type PipelineComponent = {
	connected: boolean
	/** Messages (or requests) per minute, trailing 60 s. */
	perMin: number
	latencyP50Ms: number | null
	connectedForMs: number | null
	reconnects: number
	errors: number
}

export type LatencySample = {
	signature: string
	/** Slot reference → gRPC arrival. */
	grpcMs: number
	/** Slot reference → Blur arrival; null if Blur hasn't delivered (or never will) this signature. */
	blurMs: number | null
	ts: number
}

export type Pipeline = {
	source: string
	startedAt: number
	uptimeMs: number
	grpc: PipelineComponent & { lastSlot: number }
	blur: PipelineComponent
	dataApi: PipelineComponent
	indexer: { perMin: number; eventsPerMin: number; processP50Ms: number | null }
	sse: { clients: number; pushesPerMin: number; slotToPushP50Ms: number | null }
	/** Share (0..1) of matched signatures where gRPC arrived before Blur; null if none matched. */
	grpcFirstShare: number | null
	/** Last ~100 gRPC txs with DBC events, oldest first. */
	samples: LatencySample[]
}

export type AlertType = 'curve' | 'graduated' | 'risk'

/** Exact JSON body POSTed to ALERT_WEBHOOK_URL. */
export type AlertPayload = {
	type: AlertType
	pool: string
	mint: string | null
	symbol: string | null
	name: string | null
	curveProgress: number | null
	timeToGraduateMs?: number
	riskScore: number
	flag?: RiskFlag
	url: string
	ts: number
}

export type AlertDelivery = {
	dest: 'webhook' | 'telegram'
	ok: boolean
	/** HTTP status of the last attempt; null on network error / timeout / rate limit skip. */
	status: number | null
	/** Total time including retries. */
	ms: number
	attempts: number
	error?: string
	/** Telegram fan-out: messages delivered / failed across subscribers (+ the fixed chat). */
	sent?: number
	failed?: number
}

export type AlertFired = {
	id: number
	type: AlertType
	pool: string
	symbol: string | null
	/** Human line, e.g. "crossed 80% · vol 5m $817" or "curve filled in 2m 17s". */
	detail: string
	payload: AlertPayload
	deliveries: AlertDelivery[]
	ts: number
}

export type AlertsState = {
	rules: {
		curve: { enabled: boolean; threshold: number }
		graduated: { enabled: boolean; skipFastMs: number }
		risk: { enabled: boolean; flags: RiskFlag[] }
	}
	destinations: {
		/** `host` is the hostname only; the URL and secret are never exposed. */
		webhook: { enabled: boolean; host: string | null; signed: boolean; lastStatus: number | null }
		/**
		 * Subscriber bot. `enabled` = a bot token is configured; `botUsername` comes from getMe
		 * (null until it answers); `polling` = this process is receiving commands right now.
		 * Chat ids and names are never exposed.
		 */
		telegram: {
			enabled: boolean
			botUsername: string | null
			subscribers: number
			polling: boolean
			lastStatus: number | null
		}
	}
	/** `delivered` = successful deliveries over the last 24 h. */
	stats: { fired1h: number; delivered: number; activeRules: number }
	/** Last 50, newest first. */
	recent: AlertFired[]
}
