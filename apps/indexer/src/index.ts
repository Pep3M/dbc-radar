import { startServer } from './api/server'
import { config } from './config'
import { createIngestor } from './ingest'
import { createMetrics } from './metrics'
import { createPriceFeed } from './prices'
import { createRpcSource } from './sources/rpc'
import type { TxSource } from './sources/types'
import { createYellowstoneSource } from './sources/yellowstone'
import { openDb } from './store/db'

const db = openDb(config.dbPath)
const backfillUsd = db.query(`
	UPDATE trades SET usd_amount = quote_amount * $usd
	WHERE usd_amount IS NULL AND pool IN (SELECT pool FROM pools WHERE quote_mint = $mint)
`)
const prices = createPriceFeed((mint, usd) => {
	const { changes } = backfillUsd.run({ mint, usd })
	if (changes > 0) console.log(`[prices] backfilled USD for ${changes} trades quoted in ${mint}`)
})
await prices.ready
// Price every quote mint already in the DB so trades stored without USD get backfilled.
for (const { quote_mint } of db
	.query<{ quote_mint: string }, []>('SELECT DISTINCT quote_mint FROM pools WHERE quote_mint IS NOT NULL')
	.all()) {
	prices.quoteToUsd(quote_mint, 0)
}
const ingestor = createIngestor(db, prices)
const metrics = createMetrics(db, prices)

const source: TxSource = config.source === 'grpc' ? createYellowstoneSource() : createRpcSource()

if (config.source === 'rpc') {
	console.warn('[indexer] no SOLAMI_API_KEY set: falling back to public RPC (lossy under load)')
}

await source.start((tx) => {
	try {
		ingestor.handle(tx)
	} catch (error) {
		console.error(`[indexer] failed to ingest ${tx.signature}`, error)
	}
})

const server = startServer({
	port: config.port,
	sourceName: source.name,
	sourceStats: source.stats,
	metrics,
	ingestor,
})
console.log(`[indexer] API listening on http://localhost:${server.port}`)

const shutdown = async () => {
	await source.stop()
	prices.stop()
	server.stop()
	db.close()
	process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
