import { decodeDbcEvents } from './decoder/dbc'
import type { LiveEvent } from './domain/api'
import type { DbcEvent, RawTx, Swap } from './domain/types'
import type { PriceFeed } from './prices'
import type { Db } from './store/db'
import { telemetry } from './telemetry'

const POOL_AUTHORITY = 'FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM'

const KNOWN_QUOTE_MINTS = new Set([
	'So11111111111111111111111111111111111111112', // wSOL
	'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
	'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', // USD1
])

const Q64 = 2 ** 64

type PoolMints = {
	baseMint: string
	quoteMint: string
	baseDecimals: number
	quoteDecimals: number
}

// The pool authority is shared by every DBC pool, but a tx normally touches a single pool,
// so the vault balances it owns in that tx identify the pair.
const mintsFromBalances = (tx: RawTx, knownBase?: string): PoolMints | null => {
	const vaults = tx.tokenBalances.filter((b) => b.owner === POOL_AUTHORITY)
	const unique = [...new Map(vaults.map((b) => [b.mint, b])).values()]
	if (unique.length !== 2) return null
	const base =
		unique.find((b) => b.mint === knownBase) ?? unique.find((b) => !KNOWN_QUOTE_MINTS.has(b.mint))
	const quote = unique.find((b) => b !== base)
	if (!base || !quote) return null
	return {
		baseMint: base.mint,
		quoteMint: quote.mint,
		baseDecimals: base.decimals,
		quoteDecimals: quote.decimals,
	}
}

export const createIngestor = (
	db: Db,
	prices: PriceFeed,
	/** Called (inside the write transaction) the first time a pool's creator sells. */
	onCreatorSold: (pool: string, ts: number) => void = () => {},
) => {
	const listeners = new Set<(event: LiveEvent) => void>()
	let pushedThisTx = 0
	let internalListeners = 0
	const health = { txs: 0, events: 0, lastEventAt: 0, startedAt: Date.now() }

	const getPool = db.query<
		{
			base_mint: string | null
			quote_mint: string | null
			base_decimals: number | null
			quote_decimals: number | null
			creator: string | null
			symbol: string | null
		},
		[string]
	>(`
		SELECT p.base_mint, p.quote_mint, p.base_decimals, p.quote_decimals, p.creator, t.symbol
		FROM pools p LEFT JOIN tokens t ON t.mint = p.base_mint WHERE p.pool = ?
	`)

	const symbolOf = db.query<{ symbol: string | null }, [string]>(
		'SELECT symbol FROM tokens WHERE mint = ?',
	)

	const creatorSoldBefore = db.query<{ n: number }, [string, string]>(
		"SELECT 1 AS n FROM trades WHERE pool = ? AND trader = ? AND side = 'sell' LIMIT 1",
	)

	const upsertCreated = db.query(`
		INSERT INTO pools (pool, config, base_mint, creator, created_at, created_slot, created_signature, first_seen_at)
		VALUES ($pool, $config, $baseMint, $creator, $ts, $slot, $signature, $ts)
		ON CONFLICT (pool) DO UPDATE SET
			base_mint = excluded.base_mint,
			creator = excluded.creator,
			created_at = excluded.created_at,
			created_slot = excluded.created_slot,
			created_signature = excluded.created_signature
	`)

	const upsertSeen = db.query(`
		INSERT INTO pools (pool, config, first_seen_at) VALUES ($pool, $config, $ts)
		ON CONFLICT (pool) DO NOTHING
	`)

	const setMints = db.query(`
		UPDATE pools SET base_mint = $baseMint, quote_mint = $quoteMint,
			base_decimals = $baseDecimals, quote_decimals = $quoteDecimals
		WHERE pool = $pool AND quote_mint IS NULL
	`)

	const updateAfterTrade = db.query(`
		UPDATE pools SET last_trade_at = $ts, last_price = coalesce($price, last_price),
			quote_reserve = $quoteReserve, migration_threshold = $threshold, progress = $progress
		WHERE pool = $pool
	`)

	const insertTrade = db.query(`
		INSERT OR IGNORE INTO trades (signature, idx, pool, trader, side, quote_amount, usd_amount, base_amount, price, quote_reserve, slot, ts)
		VALUES ($signature, $idx, $pool, $trader, $side, $quoteAmount, $usdAmount, $baseAmount, $price, $quoteReserve, $slot, $ts)
	`)

	const markGraduated = db.query(
		'UPDATE pools SET graduated_at = $ts, progress = 1 WHERE pool = $pool AND graduated_at IS NULL',
	)

	const emit = (event: LiveEvent) => {
		for (const listener of listeners) listener(event)
		pushedThisTx += listeners.size - internalListeners
	}

	const applySwap = (tx: RawTx, swap: Swap, idx: number, ts: number) => {
		upsertSeen.run({ pool: swap.pool, config: swap.config, ts })
		const known = getPool.get(swap.pool)
		if (known?.base_decimals == null) {
			const mints = mintsFromBalances(tx, known?.base_mint ?? undefined)
			if (mints) setMints.run({ pool: swap.pool, ...mints })
		}
		const pool = getPool.get(swap.pool)
		const baseDecimals = pool?.base_decimals ?? 6
		const quoteDecimals = pool?.quote_decimals ?? 9
		const quoteAmount = Number(swap.quoteAmount) / 10 ** quoteDecimals
		const baseAmount = Number(swap.baseAmount) / 10 ** baseDecimals
		const usdAmount = prices.quoteToUsd(pool?.quote_mint ?? null, quoteAmount)
		const sqrt = Number(swap.nextSqrtPrice) / Q64
		const price =
			pool?.base_decimals == null ? null : sqrt * sqrt * 10 ** (baseDecimals - quoteDecimals)
		const threshold = Number(swap.migrationThreshold)
		const progress = threshold > 0 ? Math.min(Number(swap.quoteReserve) / threshold, 1) : null
		const quoteReserve = Number(swap.quoteReserve) / 10 ** quoteDecimals
		const isCreatorSell =
			swap.side === 'sell' &&
			pool?.creator === swap.trader &&
			!creatorSoldBefore.get(swap.pool, swap.trader)

		const { changes } = insertTrade.run({
			signature: tx.signature,
			idx,
			pool: swap.pool,
			trader: swap.trader,
			side: swap.side,
			quoteAmount,
			usdAmount,
			baseAmount,
			price,
			quoteReserve,
			slot: tx.slot,
			ts,
		})
		updateAfterTrade.run({
			pool: swap.pool,
			ts,
			price,
			quoteReserve,
			threshold: threshold / 10 ** quoteDecimals,
			progress,
		})
		emit({
			type: 'trade',
			pool: swap.pool,
			symbol: pool?.symbol ?? null,
			side: swap.side,
			trader: swap.trader,
			quoteAmount,
			usdAmount,
			price,
			progress,
			ts,
		})
		if (isCreatorSell && changes > 0) onCreatorSold(swap.pool, ts)
	}

	const apply = (tx: RawTx, events: DbcEvent[]) => {
		const ts = tx.blockTime * 1000
		events.forEach((event, idx) => {
			switch (event.kind) {
				case 'pool_created':
					upsertCreated.run({
						pool: event.pool,
						config: event.config,
						baseMint: event.baseMint,
						creator: event.creator,
						ts,
						slot: tx.slot,
						signature: tx.signature,
					})
					emit({
						type: 'pool_created',
						pool: event.pool,
						baseMint: event.baseMint,
						creator: event.creator,
						symbol: symbolOf.get(event.baseMint)?.symbol ?? null,
						ts,
					})
					break
				case 'swap':
					applySwap(tx, event, idx, ts)
					break
				case 'curve_complete':
					markGraduated.run({ pool: event.pool, ts })
					emit({ type: 'graduated', pool: event.pool, ts })
					break
			}
		})
	}

	const applyTx = db.transaction(apply)

	return {
		health,
		/** Returns the number of DBC events in the tx. */
		handle(tx: RawTx) {
			const startedAt = performance.now()
			health.txs++
			const events = decodeDbcEvents(tx)
			if (events.length > 0) {
				health.events += events.length
				health.lastEventAt = Date.now()
				pushedThisTx = 0
				applyTx(tx, events)
				telemetry.pushed(tx.slot, pushedThisTx)
			}
			telemetry.processed(performance.now() - startedAt, events.length)
			return events.length
		},
		/** Publishes an event that doesn't come from a tx (e.g. risk flags from the watcher). */
		publish: emit,
		/** `internal` listeners (alerts) don't count as SSE pushes in telemetry. */
		subscribe(listener: (event: LiveEvent) => void, internal = false) {
			listeners.add(listener)
			if (internal) internalListeners++
			return () => {
				if (listeners.delete(listener) && internal) internalListeners--
			}
		},
	}
}

export type Ingestor = ReturnType<typeof createIngestor>
