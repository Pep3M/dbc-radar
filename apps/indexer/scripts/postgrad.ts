/**
 * Precio en DAMM v2 tras graduar, frente al último precio de la curva DBC.
 * Uso (desde apps/indexer): bun scripts/postgrad.ts [muestra=40]
 */
import { Database } from 'bun:sqlite'
import {
	DAMM_V2_MIGRATION_FEE_ADDRESS,
	deriveDammV2PoolAddress,
	deriveDammV2TokenVaultAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { PublicKey } from '@solana/web3.js'

const SAMPLE = Number(process.argv[2] ?? 40)
const WSOL = 'So11111111111111111111111111111111111111112'
const key = process.env.SOLAMI_API_KEY
const RPC = key
	? `https://rpc.solami.dev/solana?api_key=${key}`
	: 'https://api.mainnet-beta.solana.com'

const db = new Database('../../data/radar.sqlite', { readonly: true })
type Row = {
	pool: string
	base_mint: string
	graduated_at: number
	migration_fee_option: number
	migration_option: number
	grad_price: number
}
const rows = db
	.query<Row, [number]>(
		`SELECT p.pool, p.base_mint, p.graduated_at, c.migration_fee_option, c.migration_option,
			(SELECT price FROM trades t WHERE t.pool = p.pool AND price IS NOT NULL ORDER BY ts DESC, slot DESC, idx DESC LIMIT 1) grad_price
		 FROM pools p JOIN dbc_configs c USING (config)
		 WHERE p.quote_mint = '${WSOL}' AND p.migration_threshold BETWEEN 1 AND 20
			AND p.graduated_at IS NOT NULL AND c.migration_option = 1 AND p.base_mint IS NOT NULL
		 ORDER BY random() LIMIT ?`,
	)
	.all(SAMPLE)

const rpc = async (method: string, params: unknown[]) => {
	for (let attempt = 0; attempt < 5; attempt++) {
		const res = await fetch(RPC, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
		}).catch(() => null)
		if (!res || res.status === 429 || res.status >= 500) {
			await Bun.sleep(500 * (attempt + 1))
			continue
		}
		const json = (await res.json()) as { result?: unknown; error?: { message: string } }
		if (json.error) throw new Error(`${method}: ${json.error.message}`)
		return json.result
	}
	throw new Error(`${method}: sin respuesta tras 5 intentos`)
}

type Sig = { signature: string; blockTime: number | null; err: unknown }
type Bal = { accountIndex: number; uiTokenAmount: { uiAmount: number | null } }
type Tx = {
	transaction: { message: { accountKeys: string[] } }
	meta: {
		err: unknown
		preTokenBalances: Bal[]
		postTokenBalances: Bal[]
		loadedAddresses?: { writable: string[]; readonly: string[] }
	} | null
	blockTime: number
}

/** Saldo de un vault concreto (por dirección), resolviendo las cuentas cargadas por ALT. */
const balanceOf = (tx: Tx, bals: Bal[], address: string) => {
	const keys = [
		...tx.transaction.message.accountKeys,
		...(tx.meta?.loadedAddresses?.writable ?? []),
		...(tx.meta?.loadedAddresses?.readonly ?? []),
	]
	const idx = keys.indexOf(address)
	if (idx < 0) return null
	return bals.find((b) => b.accountIndex === idx)?.uiTokenAmount.uiAmount ?? 0
}

const CHECKPOINTS = [10, 30, 60, 300, 900, 3600] // s tras graduar

const analyse = async (r: Row) => {
	const damm = deriveDammV2PoolAddress(
		DAMM_V2_MIGRATION_FEE_ADDRESS[r.migration_fee_option],
		new PublicKey(r.base_mint),
		new PublicKey(WSOL),
	).toBase58()
	const solVault = deriveDammV2TokenVaultAddress(
		new PublicKey(damm),
		new PublicKey(WSOL),
	).toBase58()
	const baseVault = deriveDammV2TokenVaultAddress(
		new PublicKey(damm),
		new PublicKey(r.base_mint),
	).toBase58()
	const gradS = r.graduated_at / 1000
	// paginar hacia atrás hasta antes de la graduación
	const sigs: Sig[] = []
	let before: string | undefined
	for (let page = 0; page < 15; page++) {
		const batch = (await rpc('getSignaturesForAddress', [damm, { limit: 1000, before }])) as Sig[]
		sigs.push(...batch)
		if (batch.length < 1000 || (batch.at(-1)?.blockTime ?? 0) < gradS - 30) break
		before = batch.at(-1)?.signature
	}
	const window = sigs
		.filter(
			(s) =>
				!s.err && s.blockTime != null && s.blockTime >= gradS - 30 && s.blockTime <= gradS + 3600,
		)
		.reverse()
	// todo lo del primer minuto, luego muestreo
	const early = window.filter((s) => (s.blockTime ?? 0) <= gradS + 60)
	const late = window.filter((s) => (s.blockTime ?? 0) > gradS + 60)
	const step = Math.max(1, Math.ceil(late.length / 80))
	const picked = [...early.slice(0, 120), ...late.filter((_, i) => i % step === 0)]

	const points: { t: number; price: number }[] = []
	for (let i = 0; i < picked.length; i += 8) {
		const txs = await Promise.all(
			picked
				.slice(i, i + 8)
				.map(
					(s) =>
						rpc('getTransaction', [
							s.signature,
							{ maxSupportedTransactionVersion: 1, commitment: 'confirmed' },
						]) as Promise<Tx | null>,
				),
		)
		for (const tx of txs) {
			if (!tx?.meta || tx.meta.err) continue
			const solPre = balanceOf(tx, tx.meta.preTokenBalances, solVault)
			const solPost = balanceOf(tx, tx.meta.postTokenBalances, solVault)
			const basePre = balanceOf(tx, tx.meta.preTokenBalances, baseVault)
			const basePost = balanceOf(tx, tx.meta.postTokenBalances, baseVault)
			if (solPre == null || solPost == null || basePre == null || basePost == null) continue
			const dSol = solPost - solPre
			const dBase = basePost - basePre
			if (dSol === 0 || dBase === 0 || Math.sign(dSol) === Math.sign(dBase)) continue // no es un swap
			points.push({ t: tx.blockTime - gradS, price: Math.abs(dSol / dBase) })
		}
	}
	points.sort((a, b) => a.t - b.t)
	const at = (s: number) => {
		const p = points.filter((x) => x.t <= s).at(-1)
		return p ? p.price / r.grad_price : null
	}
	const max5 = Math.max(0, ...points.filter((x) => x.t <= 300).map((x) => x.price / r.grad_price))
	return {
		pool: r.pool,
		swaps: window.length,
		decoded: points.length,
		max5,
		...Object.fromEntries(CHECKPOINTS.map((c) => [`${c}s`, at(c)])),
	}
}

const results = []
for (const r of rows) {
	try {
		const res = await analyse(r)
		results.push(res)
		console.error(
			`${results.length}/${rows.length} ${r.pool.slice(0, 6)} swaps=${res.swaps} decoded=${res.decoded}`,
		)
	} catch (e) {
		console.error(`fallo ${r.pool.slice(0, 6)}: ${(e as Error).message}`)
	}
}

const fmt = (x: number | null) =>
	x == null ? '—' : `${x >= 1 ? '+' : ''}${((x - 1) * 100).toFixed(0)}%`
console.table(
	results.map((r) => ({
		pool: r.pool.slice(0, 8),
		swaps1h: r.swaps,
		'max 5m': fmt(r.max5 || null),
		...Object.fromEntries(
			CHECKPOINTS.map((c) => [`+${c}s`, fmt(r[`${c}s` as keyof typeof r] as number | null)]),
		),
	})),
)
const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]
console.log('\nMediana del precio relativo al de graduación:')
for (const c of CHECKPOINTS) {
	const xs = results
		.map((r) => r[`${c}s` as keyof typeof r] as number | null)
		.filter((x): x is number => x != null)
	if (xs.length)
		console.log(
			`  +${c}s: ${fmt(median(xs))} (n=${xs.length}, ≥grad: ${xs.filter((x) => x >= 1).length})`,
		)
}
