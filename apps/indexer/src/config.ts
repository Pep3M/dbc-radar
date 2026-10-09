export type SourceKind = 'grpc' | 'rpc'

const env = (key: string, fallback?: string) => {
	const value = process.env[key] ?? fallback
	if (value === undefined) throw new Error(`Missing env var ${key}`)
	return value
}

const source = env('SOURCE', process.env.SOLAMI_API_KEY ? 'grpc' : 'rpc') as SourceKind

export const config = {
	source,
	solamiApiKey: process.env.SOLAMI_API_KEY ?? '',
	grpcUrl: env('SOLAMI_GRPC_URL', 'https://grpc.solami.dev'),
	/** `processed` delivers txs as soon as the validator sees them; `confirmed` waits ~0.5-1 s for votes. */
	grpcCommitment: env('GRPC_COMMITMENT', 'processed') as 'processed' | 'confirmed',
	dataApiUrl: env('SOLAMI_DATA_API_URL', 'https://api.solami.dev'),
	blurWsUrl: env('SOLAMI_BLUR_WS_URL', 'wss://ws.solami.dev/data/subscribe'),
	rpcUrl: env('RPC_URL', 'https://api.mainnet-beta.solana.com'),
	/** Solami RPC; only accepts the key as `?api_key=`, so the full URL is never logged. */
	solamiRpcUrl: env('SOLAMI_RPC_URL', 'https://rpc.solami.dev/solana'),
	wsUrl: process.env.RPC_WS_URL,
	rpcMaxConcurrency: Number(env('RPC_MAX_CONCURRENCY', '4')),
	port: Number(env('PORT', '4000')),
	dbPath: env('DB_PATH', '../../data/radar.sqlite'),
	publicUrl: env('PUBLIC_URL', 'https://pep3marquez.com/dbc-radar').replace(/\/+$/, ''),
	alerts: {
		webhookUrl: process.env.ALERT_WEBHOOK_URL || null,
		webhookSecret: process.env.ALERT_WEBHOOK_SECRET || null,
		telegramToken: process.env.TELEGRAM_BOT_TOKEN || null,
		/** Optional fixed destination (e.g. a channel) that receives every site-wide alert. */
		telegramChatId: process.env.TELEGRAM_CHAT_ID || null,
		/** Long-poll getUpdates for subscriber commands. Only one process per bot may poll. */
		telegramPolling: env('TELEGRAM_POLLING', '1') !== '0',
		/** 0 (or anything outside 0..1) disables the curve rule. */
		curveThreshold: Number(env('ALERT_CURVE_THRESHOLD', '0.8')),
		graduations: env('ALERT_GRADUATIONS', '1') !== '0',
		/** Empty or 'none' disables the risk rule. */
		flags: env('ALERT_FLAGS', 'creator_sold')
			.split(',')
			.map((f) => f.trim())
			.filter((f) => f && f !== 'none'),
		skipFastGraduationsMs: Number(env('ALERT_SKIP_FAST_GRADUATIONS_MS', '60000')),
	},
}
