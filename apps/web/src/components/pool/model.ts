'use client'

import type { PoolDetail } from '@/lib/api'
import { price as fmtPrice } from '@/lib/format'

/*
 * Shared, framework-free helpers for the pool page canvases (bonding curve, flow). The
 * canvases draw every frame from refs, never from React state (handoff step 3).
 */

export type Trade = PoolDetail['recentTrades'][number]
export type FlowBucket = { bucket: number; buyUsd: number; sellUsd: number }

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
export const easeOut = (k: number) => 1 - (1 - k) ** 3
export const TAU = Math.PI * 2

/** Live events of this pool that land before the next snapshot (drawn instantly on the curve). */
export type LiveTick = {
	side: 'buy' | 'sell'
	usd: number
	/** Curve progress after the trade (0..1). */
	progress: number
	trader: string
	ts: number
	/** performance.now() when it arrived (drives the grow-in animation). */
	t0: number
}

/** Mutable model shared by the page and the curve canvas. */
export type LiveModel = {
	ticks: LiveTick[]
	/** Latest progress pushed by the stream (overrides the snapshot until the next one). */
	progress: number | null
	/** performance.now() of a graduation seen live (burst rings), or null. */
	gradAt: number | null
	/** performance.now() of a creator sell seen live (target-lock brackets), or null. */
	rugAt: number | null
}

export const createLiveModel = (): LiveModel => ({
	ticks: [],
	progress: null,
	gradAt: null,
	rugAt: null,
})

/* ───────────────────────────── Colours ───────────────────────────── */

export type Palette = Record<
	| 'bg'
	| 'bg2'
	| 'bg3'
	| 'line'
	| 'lineSoft'
	| 'ink'
	| 'ink2'
	| 'ink3'
	| 'signal'
	| 'buy'
	| 'sell'
	| 'risk',
	string
> & { mono: string }

/** Reads the colour tokens once (canvas 2D parses oklch directly). */
export const readPalette = (): Palette => {
	const cs = getComputedStyle(document.documentElement)
	const g = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
	const mono = cs.getPropertyValue('--font-spline-sans-mono').trim()
	return {
		bg: g('--color-bg', '#16130f'),
		bg2: g('--color-bg-2', '#1e1b17'),
		bg3: g('--color-bg-3', '#28241f'),
		line: g('--color-line', '#3d3832'),
		lineSoft: g('--color-line-soft', '#2c2823'),
		ink: g('--color-ink', '#f3efe6'),
		ink2: g('--color-ink-2', '#c3beb4'),
		ink3: g('--color-ink-3', '#99938a'),
		signal: g('--color-signal', '#f5b942'),
		buy: g('--color-buy', '#7cc6f2'),
		sell: g('--color-sell', '#f08a5d'),
		risk: g('--color-risk', '#e8484f'),
		mono: mono ? `${mono}, monospace` : '"Spline Sans Mono", monospace',
	}
}

/** Adds alpha to an `oklch(...)` / `rgb(...)` colour string. */
export const alpha = (color: string, a: number) =>
	/\)\s*$/.test(color) && !color.includes('/') ? color.replace(/\)\s*$/, ` / ${a})`) : color

/** Sizes a canvas to its CSS box × DPR and clears it. */
export const fitCanvas = (canvas: HTMLCanvasElement | null) => {
	if (!canvas) return null
	const w = canvas.clientWidth
	const h = canvas.clientHeight
	if (!w || !h) return null
	const dpr = window.devicePixelRatio || 1
	const W = Math.round(w * dpr)
	const H = Math.round(h * dpr)
	if (canvas.width !== W || canvas.height !== H) {
		canvas.width = W
		canvas.height = H
	}
	const ctx = canvas.getContext('2d')
	if (!ctx) return null
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
	ctx.clearRect(0, 0, w, h)
	return { ctx, w, h }
}

/* ───────────────────────────── Curve sampler ───────────────────────────── */

export type Sampler = {
	/** Migration threshold in quote units (x axis end). */
	threshold: number
	/** Reserve domain covered by samples. */
	min: number
	max: number
	pmin: number
	pmax: number
	/** True when drawn from the pool's real DBC curve config, false when traced from trades. */
	real: boolean
	/** Price (quote per token) at a quote reserve, null outside the sampled domain. */
	at: (reserve: number) => number | null
	/** Quote reserve for a price (inverse), only for the real (monotonic) curve. */
	reserveOf: (price: number) => number | null
}

type Point = { quoteReserve: number; price: number }

const interpolate = (pts: Point[], x: number, key: 'quoteReserve' | 'price') => {
	const other = key === 'quoteReserve' ? 'price' : 'quoteReserve'
	let lo = 0
	let hi = pts.length - 1
	if (x < pts[lo][key] || x > pts[hi][key]) return null
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1
		if (pts[mid][key] <= x) lo = mid
		else hi = mid
	}
	const a = pts[lo]
	const b = pts[hi]
	const span = b[key] - a[key]
	if (span <= 0) return a[other]
	return a[other] + ((x - a[key]) / span) * (b[other] - a[other])
}

/**
 * Builds the price-vs-reserve function. Prefers the real curve from the indexer (`curve`);
 * when it isn't loaded yet, traces the segment covered by trades that carry `quote_reserve`.
 * Returns null when neither gives two distinct points or the threshold is unknown.
 */
export const buildSampler = (data: PoolDetail): Sampler | null => {
	const curve = (data.curve ?? []).filter(
		(p) => Number.isFinite(p.quoteReserve) && Number.isFinite(p.price) && p.price > 0,
	)
	if (curve.length >= 2) {
		const pts = [...curve].sort((a, b) => a.quoteReserve - b.quoteReserve)
		const threshold = data.migrationThreshold || pts[pts.length - 1].quoteReserve
		const byPrice = [...pts].sort((a, b) => a.price - b.price)
		return {
			threshold,
			min: pts[0].quoteReserve,
			max: pts[pts.length - 1].quoteReserve,
			pmin: byPrice[0].price,
			pmax: byPrice[byPrice.length - 1].price,
			real: true,
			at: (r) => interpolate(pts, r, 'quoteReserve'),
			reserveOf: (p) => interpolate(byPrice, p, 'price'),
		}
	}
	const threshold = data.migrationThreshold
	if (!threshold) return null
	const raw: Point[] = (data.recentTrades ?? [])
		.filter((t) => t.quote_reserve != null && t.price != null && t.price > 0)
		.map((t) => ({ quoteReserve: t.quote_reserve as number, price: t.price as number }))
	if (data.quoteReserve != null && data.price) {
		raw.push({ quoteReserve: data.quoteReserve, price: data.price })
	}
	raw.sort((a, b) => a.quoteReserve - b.quoteReserve)
	const pts: Point[] = []
	for (const p of raw) {
		const last = pts[pts.length - 1]
		if (last && Math.abs(last.quoteReserve - p.quoteReserve) < 1e-9) last.price = p.price
		else pts.push({ ...p })
	}
	if (pts.length < 2) return null
	const prices = pts.map((p) => p.price)
	return {
		threshold,
		min: pts[0].quoteReserve,
		max: pts[pts.length - 1].quoteReserve,
		pmin: Math.min(...prices),
		pmax: Math.max(...prices),
		real: false,
		at: (r) => interpolate(pts, r, 'quoteReserve'),
		reserveOf: () => null,
	}
}

/* ───────────────────────────── Flow ───────────────────────────── */

/**
 * Flow buckets for a window. Uses the indexer's zero-filled buckets when present; older
 * indexers don't send them, so fall back to bucketing the recent trades client-side.
 */
export const flowBuckets = (data: PoolDetail, win: '5m' | '1h', now: number): FlowBucket[] => {
	const given = win === '5m' ? data.flow5m : data.flow1h
	if (given && given.length > 0) return given
	const n = win === '5m' ? 30 : 60
	const span = win === '5m' ? 10_000 : 60_000
	const end = now || Date.now()
	const start = end - n * span
	const out: FlowBucket[] = Array.from({ length: n }, (_, i) => ({
		bucket: start + i * span,
		buyUsd: 0,
		sellUsd: 0,
	}))
	for (const t of data.recentTrades ?? []) {
		if (t.ts < start || t.ts > end || t.usd_amount == null) continue
		const k = Math.min(n - 1, Math.floor((t.ts - start) / span))
		if (t.side === 'buy') out[k].buyUsd += t.usd_amount
		else out[k].sellUsd += t.usd_amount
	}
	return out
}

/** USD per quote token implied by the snapshot (null when unknown). */
export const usdPerQuote = (data: Pick<PoolDetail, 'price' | 'priceUsd'>) =>
	data.price && data.priceUsd ? data.priceUsd / data.price : null

/** Formats a quote-denominated price in USD when the rate is known, else in quote units. */
export const quotePrice = (p: number | null | undefined, rate: number | null, quote: string) => {
	if (p == null) return fmtPrice(null)
	if (rate) return fmtPrice(p * rate)
	return `${fmtPrice(p).slice(1)} ${quote}`
}

/** Quote amount: 2 decimals, or 2 significant digits for dust-sized test curves (0.00001). */
export const qty = (v: number) =>
	v !== 0 && Math.abs(v) < 0.01 ? String(Number(v.toPrecision(2))) : v.toFixed(2)
