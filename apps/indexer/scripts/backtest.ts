/**
 * Backtest de estrategias sobre la SQLite de DBC Radar.
 * Uso (desde apps/indexer): bun scripts/backtest.ts [ruta.sqlite]
 *
 * Modelo de ejecución (conservador):
 * - La señal se evalúa al ver un trade; entramos al precio spot del primer trade con ts >= señal + LAT.
 * - Salida igual: al primer trade con ts >= disparo + LAT (o al último precio si no hay más trades;
 *   en una bonding curve siempre puedes vender contra la curva).
 * - Costes por lado: comisión FEE + slippage SLIP, más FIXED SOL por transacción (priority + Jito).
 * - Si el pool se gradúa con la posición abierta no sabemos el precio en DAMM v2: se marca al último
 *   precio de la curva (optimista) y se reporta aparte con un recorte GRAD_HAIRCUT (pesimista).
 */
import { Database } from 'bun:sqlite'

const db = new Database(process.argv[2] ?? '../../data/radar.sqlite', { readonly: true })

const SIZE = 0.2 // SOL por operación
const FIXED = 0.001 // SOL por tx
const LAT = 2000 // ms de latencia señal → ejecución
const GRAD_HAIRCUT = 0.2 // pérdida media medida vendiendo en DAMM v2 a los ~10 s de graduar

type Pool = {
	pool: string
	creator: string | null
	threshold: number
	graduated_at: number | null
	created_at: number | null
}
type Trade = {
	trader: string
	side: 'buy' | 'sell'
	q: number
	price: number
	reserve: number
	ts: number
}

const pools = db
	.query<Pool, []>(
		`SELECT pool, creator, migration_threshold threshold, graduated_at, created_at FROM pools
		 WHERE quote_mint = 'So11111111111111111111111111111111111111112' AND migration_threshold >= 1`,
	)
	.all()
const tradesOf = db.query<Trade, [string]>(
	`SELECT trader, side, quote_amount q, price, quote_reserve reserve, ts FROM trades
	 WHERE pool = ? AND price IS NOT NULL AND quote_reserve IS NOT NULL ORDER BY ts, slot, idx`,
)
const dataEnd = db.query<{ m: number }, []>('SELECT max(ts) m FROM trades').get()!.m

const data = pools
	.map((p) => ({ ...p, trades: tradesOf.all(p.pool) }))
	.filter((p) => p.trades.length > 0)

// ---------- señales ----------
type Ctx = { p: (typeof data)[number]; i: number; t0: number }
type Signal = { name: string; fire: (c: Ctx) => boolean }

const progress = (c: Ctx) => c.p.trades[c.i].reserve / c.p.threshold
const stats = (c: Ctx) => {
	const now = c.p.trades[c.i].ts
	const buyers = new Map<string, number>()
	let creatorSold = false
	let buy5 = 0
	let sell5 = 0
	let buyVol = 0
	for (let k = 0; k <= c.i; k++) {
		const t = c.p.trades[k]
		if (t.side === 'buy') {
			buyers.set(t.trader, (buyers.get(t.trader) ?? 0) + t.q)
			buyVol += t.q
		} else if (t.trader === c.p.creator) creatorSold = true
		if (now - t.ts <= 300_000) t.side === 'buy' ? (buy5 += t.q) : (sell5 += t.q)
	}
	const topShare = buyVol > 0 ? Math.max(...buyers.values()) / buyVol : 1
	return {
		uniqueBuyers: buyers.size,
		creatorSold,
		whale: topShare > 0.4,
		dumping: sell5 > 1.5 * buy5,
	}
}
const clean = (c: Ctx) => {
	const s = stats(c)
	return !s.creatorSold && !s.whale && !s.dumping
}

const signals: Signal[] = [
	{ name: 'primer trade', fire: (c) => c.i === 0 },
	...[0.3, 0.5, 0.7, 0.85].flatMap((x) => [
		{ name: `progreso ≥${x * 100}%`, fire: (c: Ctx) => progress(c) >= x },
		{ name: `progreso ≥${x * 100}% + limpio`, fire: (c: Ctx) => progress(c) >= x && clean(c) },
	]),
	{
		name: '≥15 compradores en 2 min + limpio',
		fire: (c) => c.p.trades[c.i].ts - c.t0 <= 120_000 && stats(c).uniqueBuyers >= 15 && clean(c),
	},
]

// ---------- salidas ----------
type Exit = {
	name: string
	tp: number | null
	sl: number | null
	maxMs: number | null
	prog?: number
}
const exits: Exit[] = [
	{ name: 'TP+50% / SL-30% / 30m', tp: 0.5, sl: -0.3, maxMs: 30 * 60_000 },
	{ name: 'TP+100% / SL-40% / 60m', tp: 1, sl: -0.4, maxMs: 60 * 60_000 },

	{ name: 'aguantar hasta graduar', tp: null, sl: null, maxMs: null },
	{ name: 'vender en curva al 90% / SL-30%', tp: null, sl: -0.3, maxMs: null, prog: 0.9 },
	{ name: 'vender en curva al 95% / SL-30%', tp: null, sl: -0.3, maxMs: null, prog: 0.95 },
]

const firstAt = (tr: Trade[], from: number, ts: number) => {
	for (let k = from; k < tr.length; k++) if (tr[k].ts >= ts) return k
	return -1
}

type Result = { ret: number; grad: boolean }
const simulate = (p: (typeof data)[number], sig: Signal, ex: Exit, cost: number): Result | null => {
	const tr = p.trades
	const t0 = tr[0].ts
	let s = -1
	for (let i = 0; i < tr.length; i++) {
		if (p.graduated_at && tr[i].ts >= p.graduated_at) break
		if (sig.fire({ p, i, t0 })) {
			s = i
			break
		}
	}
	if (s < 0) return null
	const e = firstAt(tr, s, tr[s].ts + LAT)
	if (e < 0) return null
	if (p.graduated_at && tr[e].ts >= p.graduated_at) return null // demasiado tarde: ya graduó
	const entry = tr[e].price
	const entryTs = tr[e].ts

	let exitPrice = tr[tr.length - 1].price
	let grad = p.graduated_at != null
	for (let k = e + 1; k < tr.length; k++) {
		const r = tr[k].price / entry - 1
		const timedOut = ex.maxMs != null && tr[k].ts - entryTs >= ex.maxMs
		if (
			(ex.prog != null && tr[k].reserve / p.threshold >= ex.prog) ||
			(ex.tp != null && r >= ex.tp) ||
			(ex.sl != null && r <= ex.sl) ||
			timedOut
		) {
			const x = firstAt(tr, k, tr[k].ts + LAT)
			exitPrice = tr[x < 0 ? tr.length - 1 : x].price
			grad = p.graduated_at != null && x < 0 && tr[tr.length - 1].ts >= p.graduated_at - 1
			break
		}
	}
	// sin graduar, sin disparar y sin datos al final: la posición queda abierta al último precio
	const gross = exitPrice / entry
	const ret = gross * (1 - cost) * (1 - cost) - 1 - (2 * FIXED) / SIZE
	return { ret, grad }
}

// ---------- informe ----------
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`
console.log(
	`Datos: ${data.length} pools SOL con umbral ≥1 SOL · ${((dataEnd - Math.min(...data.map((p) => p.trades[0].ts))) / 3.6e6).toFixed(1)} h · tamaño ${SIZE} SOL · latencia ${LAT} ms\n`,
)
for (const cost of [0.02]) {
	console.log(`=== Coste por lado ${cost * 100}% (comisión + slippage) ===`)
	const rows = []
	for (const sig of signals)
		for (const ex of exits) {
			const rs = data.map((p) => simulate(p, sig, ex, cost)).filter((r): r is Result => r != null)
			if (rs.length === 0) continue
			const sum = rs.reduce((a, r) => a + r.ret, 0)
			const pess = rs.reduce(
				(a, r) => a + (r.grad ? (1 + r.ret) * (1 - GRAD_HAIRCUT) - 1 : r.ret),
				0,
			)
			const sorted = rs.map((r) => r.ret).sort((a, b) => a - b)
			rows.push({
				señal: sig.name,
				salida: ex.name,
				n: rs.length,
				win: `${((rs.filter((r) => r.ret > 0).length / rs.length) * 100).toFixed(0)}%`,
				'grad%': `${((rs.filter((r) => r.grad).length / rs.length) * 100).toFixed(0)}%`,
				'media/op': pct(sum / rs.length),
				mediana: pct(sorted[Math.floor(sorted.length / 2)]),
				'PnL SOL': (sum * SIZE).toFixed(2),
				'PnL pesim.': (pess * SIZE).toFixed(2),
			})
		}
	console.table(rows)
}
