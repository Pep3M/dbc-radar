export const shortAddress = (address: string | null, size = 4) =>
	address ? `${address.slice(0, size)}…${address.slice(-size)}` : '—'

export const usd = (value: number | null | undefined) => {
	if (value == null) return '—'
	if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`
	if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}k`
	if (value >= 1) return `$${value.toFixed(2)}`
	return `$${value.toFixed(3)}`
}

export const price = (value: number | null | undefined) => {
	if (value == null) return '—'
	if (value >= 0.01) return `$${value.toFixed(4)}`
	// Subscript-zero notation used by trading terminals: $0.0₅1234
	const [, decimals = ''] = value.toFixed(20).split('.')
	const zeros = decimals.match(/^0*/)?.[0].length ?? 0
	const digits = decimals.slice(zeros, zeros + 4)
	const subscript = String(zeros)
		.split('')
		.map((d) => '₀₁₂₃₄₅₆₇₈₉'[Number(d)])
		.join('')
	return `$0.0${subscript}${digits}`
}

export const pct = (value: number | null | undefined, digits = 1) =>
	value == null ? '—' : `${(value * 100).toFixed(digits)}%`

export const age = (ts: number | null | undefined, now: number) => {
	if (!ts || !now) return '—'
	const s = Math.max(0, Math.floor((now - ts) / 1000))
	if (s < 60) return `${s}s`
	if (s < 3600) return `${Math.floor(s / 60)}m`
	if (s < 86_400) return `${Math.floor(s / 3600)}h`
	return `${Math.floor(s / 86_400)}d`
}

export const duration = (ms: number) => {
	const s = Math.round(ms / 1000)
	if (s < 60) return `${s}s`
	if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
	return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

export const links = {
	solscanToken: (mint: string) => `https://solscan.io/token/${mint}`,
	solscanAccount: (address: string) => `https://solscan.io/account/${address}`,
	solscanTx: (signature: string) => `https://solscan.io/tx/${signature}`,
	jupiter: (mint: string) => `https://jup.ag/tokens/${mint}`,
}
