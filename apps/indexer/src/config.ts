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
	dataApiUrl: env('SOLAMI_DATA_API_URL', 'https://api.solami.dev'),
	blurWsUrl: env('SOLAMI_BLUR_WS_URL', 'wss://ws.solami.dev/data/subscribe'),
	rpcUrl: env('RPC_URL', 'https://api.mainnet-beta.solana.com'),
	wsUrl: process.env.RPC_WS_URL,
	rpcMaxConcurrency: Number(env('RPC_MAX_CONCURRENCY', '4')),
	port: Number(env('PORT', '4000')),
	dbPath: env('DB_PATH', '../../data/radar.sqlite'),
}
