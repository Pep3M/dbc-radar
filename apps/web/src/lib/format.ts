/**
 * Number and time formatting for DBC Radar. Render every output in Spline Sans Mono with
 * `tabular-nums` (the `num` utility). Missing or invalid values are always an em dash, never
 * `0`, `NaN` or `100%`.
 */

export const EMPTY = '—'

const valid = (value: number | null | undefined): value is number =>
	value != null && Number.isFinite(value)

export const shortAddress = (address: string | null | undefined, size = 4) =>
	address ? `${address.slice(0, size)}…${address.slice(-size)}` : EMPTY

/** Compact USD: `$1.24M`, `$264.3k`, `$12.40`, `$0.512`. */
export const usd = (value: number | null | undefined) => {
	if (!valid(value)) return EMPTY
	const sign = value < 0 ? '-' : ''
	const v = Math.abs(value)
	if (v >= 1_000_000_000) return `${sign}$${(v / 1_000_000_000).toFixed(2)}B`
	if (v >= 1_000_000) return `${sign}$${(v / 1_000_000).toFixed(2)}M`
	if (v >= 1_000) return `${sign}$${(v / 1_000).toFixed(1)}k`
	if (v === 0) return '$0'
	if (v >= 1) return `${sign}$${v.toFixed(2)}`
	return `${sign}$${v.toFixed(3)}`
}

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉'

/**
 * Token price. From $0.01 up: 4 decimals (2 from $1,000). Below that, subscript-zero
 * notation as in trading terminals: 0.00003294 → `$0.0₄3294` (subscript = zeros after the
 * decimal point). Zero or missing → em dash.
 */
export const price = (value: number | null | undefined) => {
	if (!valid(value) || value <= 0) return EMPTY
	if (value >= 1_000) return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
	if (value >= 0.01) return `$${value.toFixed(4)}`
	const [, decimals = ''] = value.toFixed(20).split('.')
	const zeros = decimals.match(/^0*/)?.[0].length ?? 0
	const digits = decimals.slice(zeros, zeros + 4).replace(/0+$/, '') || '0'
	const subscript = String(zeros)
		.split('')
		.map((d) => SUBSCRIPT[Number(d)])
		.join('')
	return `$0.0${subscript}${digits}`
}

/** Ratio (0..1) as a percentage: `pct(0.884)` → `88.4%`. */
export const pct = (value: number | null | undefined, digits = 1) =>
	valid(value) ? `${(value * 100).toFixed(digits)}%` : EMPTY

/** Curve progress (0..1) as a whole percentage, clamped: `76%`. */
export const progressPct = (value: number | null | undefined) =>
	valid(value) ? `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` : EMPTY

/** Integer with thousands separators: `15,601`. */
export const int = (value: number | null | undefined) =>
	valid(value) ? Math.round(value).toLocaleString('en-US') : EMPTY

/** Compact count: `1.2k`, `3.4M`, `912`. */
export const count = (value: number | null | undefined) => {
	if (!valid(value)) return EMPTY
	const v = Math.abs(value)
	if (v >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
	if (v >= 10_000) return `${(value / 1_000).toFixed(1)}k`
	return Math.round(value).toLocaleString('en-US')
}

/** Elapsed milliseconds, single unit: `12s`, `4m`, `3h`, `2d`. */
export const ago = (ms: number | null | undefined) => {
	if (!valid(ms)) return EMPTY
	const s = Math.max(0, Math.floor(ms / 1000))
	if (s < 60) return `${s}s`
	if (s < 3600) return `${Math.floor(s / 60)}m`
	if (s < 86_400) return `${Math.floor(s / 3600)}h`
	return `${Math.floor(s / 86_400)}d`
}

/**
 * Age of a timestamp relative to `now`. `now` is 0 until mounted (see `useNow`), so the
 * prerendered shell prints an em dash instead of a clock-dependent value.
 */
export const age = (ts: number | null | undefined, now: number) =>
	!ts || !now ? EMPTY : ago(now - ts)

/** Duration, two units: `38s`, `4m 12s`, `2h 5m`. */
export const duration = (ms: number | null | undefined) => {
	if (!valid(ms)) return EMPTY
	const s = Math.max(0, Math.round(ms / 1000))
	if (s < 60) return `${s}s`
	if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
	if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
	return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`
}

/** Seconds with one decimal, for stream latency: `0.1s`. */
export const seconds = (ms: number | null | undefined) =>
	valid(ms) ? `${(ms / 1000).toFixed(1)}s` : EMPTY

/** Milliseconds, for pipeline latency: `61ms`, `1.2s`. */
export const millis = (ms: number | null | undefined) => {
	if (!valid(ms)) return EMPTY
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`
}

export const links = {
	solscanToken: (mint: string) => `https://solscan.io/token/${mint}`,
	solscanAccount: (address: string) => `https://solscan.io/account/${address}`,
	solscanTx: (signature: string) => `https://solscan.io/tx/${signature}`,
	jupiter: (mint: string) => `https://jup.ag/tokens/${mint}`,
}
