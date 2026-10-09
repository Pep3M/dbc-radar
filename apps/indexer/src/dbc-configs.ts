import { BorshCoder, type Idl } from '@coral-xyz/anchor'
import {
	DAMM_V2_MIGRATION_FEE_ADDRESS,
	DynamicBondingCurveIdl,
	deriveDammV2PoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { PublicKey } from '@solana/web3.js'
import { config } from './config'
import type { CurvePoint } from './domain/api'
import type { Db } from './store/db'

const FETCH_INTERVAL_MS = 2_000
const RPC_BATCH = 100
const RETRY_MS = 5 * 60_000
const CURVE_SAMPLES = 64
const Q64 = 2 ** 64
const Q128 = 2 ** 128
// MigrationOption: 0 = DAMM v1, 1 = DAMM v2.
const MIGRATE_TO_DAMM_V2 = 1

/**
 * Launchpad attribution. A DBC config's `fee_claimer` is the integrating partner, so it
 * identifies the launchpad for every pool on that partner's configs. Partners were labelled
 * by clustering live pools (mint vanity suffix + metadata website); unknown partners stay null.
 */
const PARTNERS: Record<string, string> = {
	'5wkyL2FLEcyUUgc3UeGntHTAfWfzDrVuxMnaMm7792Gk': 'Moonshot',
	E8QjCz3aX31Qk6ieEYzfVsfqmT3dbTaTEABwUUgZVGWL: 'Jup Studio',
	'9RaoVypDNRDgy7tLLVPrJRzuR219P5ZxZ46F2TmzJpYc': 'ant.fun',
	'5y8iwkrKmr3a9zUnUEuAFBrzSDqhbHiB7Nva1s2PPyvY': 'Gomo',
	GqoM7N7GKqRwmC3GXe3dox6YPsUqmw5FCh9QmKUidF2o: 'Veldora',
	GZjYfGyUNQfDChcQ66Gc3ZMcQqPEisyRYe1nPyQhP9bp: 'Gacha',
}

// Vanity mint suffixes some launchpads grind for every token.
const MINT_SUFFIXES: [suffix: string, name: string][] = [
	['BAGS', 'Bags.fm'],
	['jups', 'Jup Studio'],
]

export const launchpadFor = (feeClaimer: string | null, baseMint: string | null) => {
	if (feeClaimer && PARTNERS[feeClaimer]) return PARTNERS[feeClaimer]
	if (baseMint)
		for (const [suffix, name] of MINT_SUFFIXES) if (baseMint.endsWith(suffix)) return name
	return null
}

const QUOTE_SYMBOLS: Record<string, string> = {
	So11111111111111111111111111111111111111112: 'SOL',
	EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
	USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB: 'USD1',
	Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
}

export const KNOWN_QUOTE_MINTS = new Set(Object.keys(QUOTE_SYMBOLS))

export const quoteSymbolFor = (quoteMint: string | null, tokenSymbol: string | null) =>
	quoteMint ? (QUOTE_SYMBOLS[quoteMint] ?? tokenSymbol) : null

type ConfigRow = {
	config: string
	fee_claimer: string | null
	token_decimal: number | null
	migration_option: number | null
	migration_fee_option: number | null
	migration_quote_threshold: string | null
	sqrt_start_price: string | null
	curve: string | null
}

type Fields = Record<string, unknown>

const coder = new BorshCoder(DynamicBondingCurveIdl as Idl)

const decodeConfig = (data: Buffer): Fields | null => {
	try {
		return coder.accounts.decode('PoolConfig', data) as Fields
	} catch {
		try {
			// Token-2022 transfer-hook configs wrap the same struct.
			return (coder.accounts.decode('ConfigWithTransferHook', data) as Fields).config as Fields
		} catch {
			return null
		}
	}
}

const rpcUrl = () =>
	config.solamiApiKey ? `${config.solamiRpcUrl}?api_key=${config.solamiApiKey}` : config.rpcUrl

/**
 * Bonding curve shape from the config's segments. Between consecutive sqrt prices the
 * pool behaves like a constant-liquidity range: Δquote = L · Δ√P / 2^128 (raw units,
 * √P in Q64.64), so for a target quote reserve we walk the segments and invert.
 */
const sampleCurve = (row: ConfigRow, baseDecimals: number, quoteDecimals: number) => {
	if (!row.curve || !row.sqrt_start_price || !row.migration_quote_threshold) return null
	const segments = JSON.parse(row.curve) as [sqrtPrice: string, liquidity: string][]
	const threshold = Number(row.migration_quote_threshold)
	if (!(threshold > 0) || segments.length === 0) return null
	const scale = 10 ** (baseDecimals - quoteDecimals)
	const priceAt = (sqrt: number) => (sqrt / Q64) ** 2 * scale

	const points: CurvePoint[] = []
	let lower = Number(row.sqrt_start_price)
	let filled = 0
	let seg = 0
	for (let i = 0; i <= CURVE_SAMPLES; i++) {
		const target = (threshold * i) / CURVE_SAMPLES
		let sqrt = lower
		while (seg < segments.length) {
			const upper = Number(segments[seg][0])
			const liquidity = Number(segments[seg][1])
			const capacity = (liquidity * (upper - lower)) / Q128
			if (target <= filled + capacity || seg === segments.length - 1) {
				sqrt = liquidity > 0 ? lower + ((target - filled) * Q128) / liquidity : lower
				break
			}
			filled += capacity
			lower = upper
			seg++
		}
		points.push({ quoteReserve: target / 10 ** quoteDecimals, price: priceAt(sqrt) })
	}
	return points
}

/**
 * Fetches each DBC config account once (Solami RPC when a key is set, public RPC
 * otherwise), batched with getMultipleAccounts, and caches it in SQLite.
 */
export const createConfigStore = (db: Db) => {
	const stats = { fetched: 0, errors: 0 }
	const failedAt = new Map<string, number>()
	const curveCache = new Map<string, CurvePoint[] | null>()

	const missing = db.query<{ config: string }, []>(`
		SELECT DISTINCT p.config FROM pools p
		LEFT JOIN dbc_configs c ON c.config = p.config
		WHERE c.config IS NULL
		ORDER BY coalesce(p.last_trade_at, p.first_seen_at) DESC
		LIMIT 500
	`)
	const getRow = db.query<ConfigRow, [string]>('SELECT * FROM dbc_configs WHERE config = ?')
	const insert = db.query(`
		INSERT OR REPLACE INTO dbc_configs (config, fee_claimer, quote_mint, token_decimal, migration_option,
			migration_fee_option, migration_quote_threshold, sqrt_start_price, curve, fetched_at)
		VALUES ($config, $feeClaimer, $quoteMint, $tokenDecimal, $migrationOption,
			$migrationFeeOption, $threshold, $sqrtStart, $curve, $now)
	`)

	const fetchMissing = async () => {
		const now = Date.now()
		const configs = missing
			.all()
			.map((r) => r.config)
			.filter((c) => now - (failedAt.get(c) ?? 0) > RETRY_MS)
			.slice(0, RPC_BATCH)
		if (configs.length === 0) return
		try {
			const res = await fetch(rpcUrl(), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 1,
					method: 'getMultipleAccounts',
					params: [configs, { encoding: 'base64' }],
				}),
				signal: AbortSignal.timeout(15_000),
			})
			if (!res.ok) throw new Error(`RPC → ${res.status}`)
			const body = (await res.json()) as {
				result?: { value: ({ data: [string, string] } | null)[] }
				error?: { message: string }
			}
			if (!body.result) throw new Error(body.error?.message ?? 'no result')
			body.result.value.forEach((account, i) => {
				const decoded = account ? decodeConfig(Buffer.from(account.data[0], 'base64')) : null
				if (!decoded) {
					failedAt.set(configs[i], now)
					return
				}
				const curve = (decoded.curve as { sqrt_price: unknown; liquidity: unknown }[])
					.map((c) => [String(c.sqrt_price), String(c.liquidity)])
					.filter(([, liquidity]) => liquidity !== '0')
				insert.run({
					config: configs[i],
					feeClaimer: String(decoded.fee_claimer),
					quoteMint: String(decoded.quote_mint),
					tokenDecimal: Number(decoded.token_decimal),
					migrationOption: Number(decoded.migration_option),
					migrationFeeOption: Number(decoded.migration_fee_option),
					threshold: String(decoded.migration_quote_threshold),
					sqrtStart: String(decoded.sqrt_start_price),
					curve: JSON.stringify(curve),
					now,
				})
				stats.fetched++
			})
		} catch (error) {
			stats.errors++
			for (const c of configs) failedAt.set(c, now)
			console.warn('[configs] fetch failed:', (error as Error).message)
		}
	}

	let timer: ReturnType<typeof setInterval> | undefined

	return {
		stats,
		start() {
			fetchMissing()
			timer = setInterval(fetchMissing, FETCH_INTERVAL_MS)
		},
		stop() {
			clearInterval(timer)
		},
		curveFor(cfg: string, baseDecimals: number | null, quoteDecimals: number | null) {
			const key = `${cfg}:${baseDecimals}:${quoteDecimals}`
			const cached = curveCache.get(key)
			if (cached) return cached
			const row = getRow.get(cfg)
			if (!row) return null
			const points = sampleCurve(row, baseDecimals ?? row.token_decimal ?? 6, quoteDecimals ?? 9)
			curveCache.set(key, points)
			return points
		},
		/** DAMM v2 pool the migration creates: a PDA of (DAMM config for the fee option, mints). */
		dammPoolFor(cfg: string, baseMint: string | null, quoteMint: string | null) {
			const row = getRow.get(cfg)
			if (!row || !baseMint || !quoteMint || row.migration_option !== MIGRATE_TO_DAMM_V2)
				return null
			const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[row.migration_fee_option ?? -1]
			if (!dammConfig) return null
			return deriveDammV2PoolAddress(
				dammConfig,
				new PublicKey(baseMint),
				new PublicKey(quoteMint),
			).toBase58()
		},
	}
}

export type ConfigStore = ReturnType<typeof createConfigStore>
