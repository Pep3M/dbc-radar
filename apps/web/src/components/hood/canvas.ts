/** Canvas helpers shared by the Under the Hood drawings (all drawn from refs, never React state). */

export type Palette = {
	ink: string
	ink2: string
	ink3: string
	line: string
	lineSoft: string
	signal: string
	buy: string
	sell: string
	risk: string
	bg: string
}

export const readPalette = (): Palette => {
	const cs = getComputedStyle(document.documentElement)
	const v = (name: string) => cs.getPropertyValue(`--color-${name}`).trim()
	return {
		ink: v('ink'),
		ink2: v('ink-2'),
		ink3: v('ink-3'),
		line: v('line'),
		lineSoft: v('line-soft'),
		signal: v('signal'),
		buy: v('buy'),
		sell: v('sell'),
		risk: v('risk'),
		bg: v('bg'),
	}
}

/** `oklch(a b c)` → `oklch(a b c / alpha)`. */
export const alpha = (color: string, a: number) => color.replace(/\)\s*$/, ` / ${a})`)

/** Sizes the backing store to the CSS box × DPR and clears it. Null while not laid out. */
export const fit = (canvas: HTMLCanvasElement | null) => {
	if (!canvas) return null
	const w = canvas.clientWidth
	const h = canvas.clientHeight
	if (!w || !h) return null
	const dpr = window.devicePixelRatio || 1
	if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
		canvas.width = Math.round(w * dpr)
		canvas.height = Math.round(h * dpr)
	}
	const ctx = canvas.getContext('2d')
	if (!ctx) return null
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
	ctx.clearRect(0, 0, w, h)
	return { ctx, w, h }
}

export const MONO = '"Spline Sans Mono", ui-monospace, monospace'

export const median = (values: number[]) => {
	if (!values.length) return null
	const s = [...values].sort((a, b) => a - b)
	return s[s.length >> 1]
}

/** Latency label: `0.4ms`, `54ms`, `1.2s`. */
export const ms = (value: number | null | undefined) => {
	if (value == null || !Number.isFinite(value)) return '—'
	if (value >= 1000) return `${(value / 1000).toFixed(1)}s`
	if (value < 10) return `${value.toFixed(1)}ms`
	return `${Math.round(value)}ms`
}
