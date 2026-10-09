'use client'

/** Design-token names available as `--color-*` CSS variables (see globals.css). */
export type ColorToken =
	| 'bg'
	| 'bg-2'
	| 'bg-3'
	| 'line'
	| 'line-soft'
	| 'ink'
	| 'ink-2'
	| 'ink-3'
	| 'signal'
	| 'signal-ink'
	| 'buy'
	| 'sell'
	| 'risk'
	| 'risk-ink'

let probe: CanvasRenderingContext2D | null = null

/**
 * Resolves a colour token to `rgba(r, g, b, a)` for libraries that cannot parse oklch
 * (lightweight-charts). Paints one pixel on a scratch canvas, so call it in an effect (client
 * only) and again when the theme changes. `alpha` multiplies the token's own alpha.
 */
export const tokenRgba = (token: ColorToken, alpha = 1) => {
	const value = getComputedStyle(document.documentElement)
		.getPropertyValue(`--color-${token}`)
		.trim()
	if (!probe) {
		const canvas = document.createElement('canvas')
		canvas.width = canvas.height = 1
		probe = canvas.getContext('2d', { willReadFrequently: true })
	}
	if (!probe || !value) return `rgba(128, 128, 128, ${alpha})`
	probe.clearRect(0, 0, 1, 1)
	probe.fillStyle = value
	probe.fillRect(0, 0, 1, 1)
	const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data
	return `rgba(${r}, ${g}, ${b}, ${((a / 255) * alpha).toFixed(3)})`
}

/** Font stack of a font token (`display`, `sans`, `mono`) for canvas/chart text. */
export const tokenFont = (token: 'display' | 'sans' | 'mono') =>
	getComputedStyle(document.documentElement).getPropertyValue(`--font-${token}`).trim() ||
	'monospace'
