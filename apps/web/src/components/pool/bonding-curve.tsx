'use client'

import { type RefObject, useEffect, useMemo, useRef } from 'react'
import type { PoolDetail } from '@/lib/api'
import { ago, usd } from '@/lib/format'
import { useReducedMotion } from '@/lib/hooks'
import {
	alpha,
	buildSampler,
	clamp,
	easeOut,
	fitCanvas,
	type LiveModel,
	type Palette,
	qty,
	quotePrice,
	readPalette,
	TAU,
	usdPerQuote,
} from './model'

type Tick = {
	key: string
	pr: number
	side: 'buy' | 'sell'
	usd: number
	ts: number
	creator: boolean
	/** performance.now() of a live arrival (grow-in), else null. */
	t0: number | null
}

/**
 * Bonding curve: price (y) against quote reserve (x) from the pool's real DBC curve, filled up
 * to the current reserve, migration threshold ring at the end. Every recent trade is a tick
 * on the curve at its post-swap reserve: buys point above, sells below, length ∝ log USD.
 * Drawn every frame from refs; the live model adds stream trades before the next snapshot.
 */
export const BondingCurve = ({
	data,
	live,
	className,
}: {
	data: PoolDetail
	live: RefObject<LiveModel>
	className?: string
}) => {
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const reduced = useReducedMotion()
	const sampler = useMemo(() => buildSampler(data), [data])
	const state = useRef({
		data,
		sampler,
		reduced,
		mk: null as number | null,
		hoverX: null as number | null,
	})
	state.current.data = data
	state.current.sampler = sampler
	state.current.reduced = reduced

	useEffect(() => {
		let palette: Palette = readPalette()
		const observer = new MutationObserver(() => {
			palette = readPalette()
		})
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-theme'],
		})
		let raf = 0
		let last = 0
		const loop = (ts: number) => {
			raf = requestAnimationFrame(loop)
			const dt = Math.min(64, ts - (last || ts))
			last = ts
			draw(canvasRef.current, state.current, live.current, palette, ts, dt)
		}
		raf = requestAnimationFrame(loop)
		return () => {
			cancelAnimationFrame(raf)
			observer.disconnect()
		}
	}, [live])

	const quote = data.quoteSymbol ?? 'SOL'

	if (!sampler) {
		return (
			<div
				className={`hatch-ink flex h-[150px] items-center justify-center border border-line-soft font-mono text-[10.5px] text-ink-3 sm:h-[380px] ${className ?? ''}`}
			>
				curve config not loaded yet · waiting for trades with reserve data
			</div>
		)
	}

	return (
		<div className={className}>
			<canvas
				ref={canvasRef}
				className="block h-[150px] w-full touch-pan-y bg-bg-2 sm:h-[380px] sm:bg-transparent"
				role="img"
				aria-label={`Bonding curve, ${Math.round((data.progress ?? 0) * 100)}% of the migration threshold`}
				onPointerMove={(e) => {
					state.current.hoverX = e.clientX - e.currentTarget.getBoundingClientRect().left
				}}
				onPointerLeave={() => {
					state.current.hoverX = null
				}}
			/>
			<div className="hidden flex-wrap gap-x-[22px] gap-y-1.5 pt-2.5 font-mono text-[10.5px] text-ink-3 sm:flex">
				<span>X · quote reserve ({quote})</span>
				<span>Y · price{usdPerQuote(data) ? ' (USD)' : ''}</span>
				<span className="text-buy">▲ buy tick above the curve</span>
				<span className="text-sell">▼ sell tick below</span>
				<span>length · log USD</span>
				{!sampler.real && <span>curve traced from trades (config pending)</span>}
			</div>
		</div>
	)
}

type DrawState = {
	data: PoolDetail
	sampler: ReturnType<typeof buildSampler>
	reduced: boolean
	mk: number | null
	hoverX: number | null
}

const draw = (
	canvas: HTMLCanvasElement | null,
	s: DrawState,
	live: LiveModel,
	C: Palette,
	ts: number,
	dt: number,
) => {
	const f = fitCanvas(canvas)
	const S = s.sampler
	if (!f || !S) return
	const { ctx, w, h } = f
	const { data, reduced } = s
	const compact = h < 220
	const quote = data.quoteSymbol ?? 'SOL'
	const rate = usdPerQuote(data)
	const L = compact ? 16 : 64
	const R = compact ? 34 : 150
	const T = compact ? 22 : 30
	const B = compact ? 18 : 34
	const th = S.threshold
	const grad = data.graduatedAt != null
	const span = S.pmax - S.pmin || S.pmax || 1
	const X = (pr: number) => L + pr * (w - L - R)
	const Y = (p: number) => T + (1 - (p - S.pmin) / span) * (h - T - B)
	const priceAt = (pr: number) => S.at(clamp(pr, 0, 1) * th)
	const pt = (pr: number): [number, number] | null => {
		const p = priceAt(pr)
		return p == null ? null : [X(pr), Y(p)]
	}
	const cur = grad ? 1 : clamp(live.progress ?? data.progress ?? 0, 0, 1)
	if (s.mk == null) s.mk = cur
	s.mk += (cur - s.mk) * (reduced ? 1 : Math.min(1, dt / 160))
	const m = clamp(s.mk, 0, 1)
	const hot = grad || cur >= 0.8
	const font = (weight: number, size: number) => `${weight} ${size}px ${C.mono}`

	// Grid + axis labels.
	ctx.lineWidth = 1
	ctx.font = font(500, 10)
	if (!compact) {
		for (const q of [0, 0.25, 0.5, 0.75, 1]) {
			const x = Math.round(X(q)) + 0.5
			ctx.strokeStyle = C.lineSoft
			ctx.beginPath()
			ctx.moveTo(x, T - 10)
			ctx.lineTo(x, h - B)
			ctx.stroke()
			ctx.fillStyle = C.ink3
			ctx.textAlign = 'center'
			ctx.fillText(`${qty(q * th)} ${quote}`, x, h - B + 18)
		}
		ctx.textAlign = 'right'
		for (const q of [0, 0.5, 1]) {
			const p = priceAt(q)
			if (p == null) continue
			const y = Math.round(Y(p)) + 0.5
			ctx.strokeStyle = C.lineSoft
			ctx.beginPath()
			ctx.moveTo(L, y)
			ctx.lineTo(w - R, y)
			ctx.stroke()
			ctx.fillStyle = C.ink3
			ctx.fillText(quotePrice(p, rate, quote), L - 8, y + 3)
		}
	}

	const N = 160
	const path = (a: number, b: number) => {
		ctx.beginPath()
		let open = false
		let lastPt: [number, number] | null = null
		for (let i = 0; i <= N; i++) {
			const p = pt(a + ((b - a) * i) / N)
			if (!p) {
				open = false
				continue
			}
			if (open) ctx.lineTo(p[0], p[1])
			else ctx.moveTo(p[0], p[1])
			open = true
			lastPt = p
		}
		return lastPt
	}

	// Filled area up to the marker.
	const fillEnd = path(0, m)
	if (fillEnd) {
		const firstPr = S.min / th
		ctx.lineTo(fillEnd[0], h - B)
		ctx.lineTo(X(clamp(firstPr, 0, 1)), h - B)
		ctx.closePath()
		ctx.fillStyle = alpha(hot ? C.signal : C.ink, hot ? 0.1 : 0.05)
		ctx.fill()
	}
	// Track (whole curve) and progress.
	path(0, 1)
	ctx.strokeStyle = C.line
	ctx.lineWidth = 2
	ctx.stroke()
	const gk = live.gradAt ? clamp((ts - live.gradAt) / 1200, 0, 1) : grad ? 1 : 0
	path(0, grad && !reduced ? Math.max(m, easeOut(gk)) : m)
	ctx.strokeStyle = hot ? C.signal : C.ink
	ctx.lineWidth = grad ? 3.5 : compact ? 3 : 2.6
	ctx.lineCap = 'round'
	ctx.stroke()
	ctx.lineCap = 'butt'

	// Trade ticks.
	const ticks = collectTicks(data, live, S)
	const now = Date.now()
	let nearest: { tick: Tick; d: number; x: number; y: number } | null = null
	for (const t of ticks) {
		const p = pt(t.pr)
		const p2 = pt(Math.min(1, t.pr + 0.003)) ?? pt(Math.max(0, t.pr - 0.003))
		if (!p || !p2) continue
		const [x, y] = p
		let nx = p2[1] - y
		let ny = -(p2[0] - x)
		if (p2[0] < x) {
			nx = -nx
			ny = -ny
		}
		const nl = Math.hypot(nx, ny) || 1
		nx /= nl
		ny /= nl
		const dir = t.side === 'buy' ? 1 : -1
		let len = (compact ? 3 : 4) + Math.log10(1 + t.usd) * (compact ? 5 : 8)
		let a = clamp(1 - (now - t.ts) / 600_000, 0.15, 1)
		if (t.t0 != null) {
			const k = (ts - t.t0) / 500
			if (k < 1 && !reduced) len *= easeOut(k)
			if (k < 3) a = 1
		}
		ctx.globalAlpha = a
		ctx.strokeStyle = t.creator ? C.risk : t.side === 'buy' ? C.buy : C.sell
		ctx.lineWidth = t.creator ? 3 : 1.4
		ctx.beginPath()
		ctx.moveTo(x + nx * 3 * dir, y + ny * 3 * dir)
		ctx.lineTo(x + nx * (3 + len) * dir, y + ny * (3 + len) * dir)
		ctx.stroke()
		if (s.hoverX != null) {
			const d = Math.abs(x - s.hoverX)
			if (d < 14 && (!nearest || d < nearest.d)) nearest = { tick: t, d, x, y }
		}
	}
	ctx.globalAlpha = 1

	// Migration threshold ring.
	const end = pt(1)
	if (end) {
		const [gx, gy] = end
		ctx.strokeStyle = C.signal
		ctx.lineWidth = 1.5
		ctx.beginPath()
		ctx.arc(gx, gy, 7, 0, TAU)
		ctx.stroke()
		if (grad) {
			ctx.fillStyle = C.signal
			ctx.beginPath()
			ctx.arc(gx, gy, 4, 0, TAU)
			ctx.fill()
		}
		if (!compact) {
			ctx.textAlign = 'left'
			ctx.fillStyle = C.signal
			ctx.font = font(600, 10)
			ctx.fillText(grad ? 'MIGRATED → DAMM v2' : 'MIGRATION THRESHOLD', gx + 14, gy - 2)
			ctx.font = font(500, 10)
			ctx.fillStyle = C.ink2
			ctx.fillText(`${qty(th)} ${quote}`, gx + 14, gy + 12)
		}
		if (live.gradAt && !reduced) {
			const k = (ts - live.gradAt) / 1400
			if (k < 1) {
				for (const off of [0, 0.2]) {
					const kk = clamp((k - off) / (1 - off), 0, 1)
					ctx.globalAlpha = 1 - kk
					ctx.lineWidth = 2
					ctx.beginPath()
					ctx.arc(gx, gy, 8 + easeOut(kk) * 70, 0, TAU)
					ctx.stroke()
				}
				ctx.globalAlpha = 1
			}
		}
	}

	// Current marker.
	const mp = pt(m)
	if (!grad && mp) {
		const [mx, my] = mp
		ctx.setLineDash([3, 4])
		ctx.strokeStyle = C.ink3
		ctx.lineWidth = 1
		ctx.beginPath()
		ctx.moveTo(mx, my)
		ctx.lineTo(mx, h - B)
		ctx.moveTo(mx, my)
		ctx.lineTo(L, my)
		ctx.stroke()
		ctx.setLineDash([])
		ctx.fillStyle = C.bg
		ctx.beginPath()
		ctx.arc(mx, my, compact ? 6 : 7, 0, TAU)
		ctx.fill()
		ctx.strokeStyle = hot ? C.signal : C.ink
		ctx.lineWidth = 2
		ctx.stroke()
		ctx.fillStyle = hot ? C.signal : C.ink
		ctx.beginPath()
		ctx.arc(mx, my, 3, 0, TAU)
		ctx.fill()
		if (!compact) {
			const lbl = `NOW ${(m * 100).toFixed(1)}% · ${quotePrice(priceAt(m), rate, quote)}`
			ctx.font = font(600, 11)
			const tw = ctx.measureText(lbl).width
			const bx = clamp(mx - tw - 22, L + 4, w - tw - 12)
			const by = Math.max(16, my - 30)
			ctx.fillStyle = C.ink
			ctx.fillRect(bx, by - 13, tw + 12, 19)
			ctx.fillStyle = C.bg
			ctx.textAlign = 'left'
			ctx.fillText(lbl, bx + 6, by)
		}

		// Creator sold: target-lock brackets snap 40 → 14 px, then blink in steps.
		if (live.rugAt) {
			const k = (performance.now() - live.rugAt) / 2200
			if (k < 1) {
				const sz = reduced || k > 0.12 ? 14 : 40 - 26 * easeOut(k / 0.12)
				ctx.globalAlpha = k > 0.12 && !reduced ? (Math.floor(k * 16) % 2 ? 0.45 : 1) : 1
				ctx.strokeStyle = C.risk
				ctx.lineWidth = 2
				for (const [sx, sy] of [
					[-1, -1],
					[1, -1],
					[1, 1],
					[-1, 1],
				]) {
					const ex = mx + sx * sz
					const ey = my + sy * sz
					ctx.beginPath()
					ctx.moveTo(ex - sx * 7, ey)
					ctx.lineTo(ex, ey)
					ctx.lineTo(ex, ey - sy * 7)
					ctx.stroke()
				}
				ctx.globalAlpha = 1
				ctx.fillStyle = C.risk
				ctx.font = font(700, 11)
				ctx.textAlign = 'left'
				ctx.fillText('CREATOR SOLD', mx + sz + 8, my + sz + 4)
			}
		}
	}

	// Hover / scrub readout.
	if (s.hoverX != null && s.hoverX >= L && s.hoverX <= w - R) {
		const hx = s.hoverX
		const pr = (hx - L) / (w - L - R)
		const p = priceAt(pr)
		ctx.strokeStyle = alpha(C.ink3, 0.6)
		ctx.lineWidth = 1
		ctx.beginPath()
		ctx.moveTo(Math.round(hx) + 0.5, T - 10)
		ctx.lineTo(Math.round(hx) + 0.5, h - B)
		ctx.stroke()
		const lines = [`${qty(pr * th)} ${quote} · ${quotePrice(p, rate, quote)}`]
		if (nearest) {
			const t = nearest.tick
			lines.push(
				`${t.side === 'buy' ? '▲' : '▼'} ${usd(t.usd)} · ${ago(now - t.ts)} ago${t.creator ? ' · creator' : ''}`,
			)
			ctx.strokeStyle = C.ink
			ctx.lineWidth = 1.5
			ctx.beginPath()
			ctx.arc(nearest.x, nearest.y, 5, 0, TAU)
			ctx.stroke()
		}
		ctx.font = font(500, 10.5)
		const tw = Math.max(...lines.map((l) => ctx.measureText(l).width))
		const bx = hx + tw + 20 > w ? hx - tw - 18 : hx + 8
		const by = h - B - 10 - lines.length * 15
		ctx.fillStyle = alpha(C.bg2, 0.94)
		ctx.fillRect(bx, by, tw + 12, lines.length * 15 + 6)
		ctx.strokeStyle = C.line
		ctx.strokeRect(bx + 0.5, by + 0.5, tw + 11, lines.length * 15 + 5)
		ctx.textAlign = 'left'
		lines.forEach((l, i) => {
			ctx.fillStyle = i === 0 ? C.ink : C.ink2
			ctx.fillText(l, bx + 6, by + 15 + i * 15)
		})
	}

	if (compact) {
		ctx.font = font(500, 9)
		ctx.fillStyle = C.ink3
		ctx.textAlign = 'right'
		ctx.fillText('tap & hold to scrub trades', w - 8, h - 6)
	}
}

/** Snapshot trades plus live ticks not yet in the snapshot, oldest first. */
const collectTicks = (
	data: PoolDetail,
	live: LiveModel,
	S: NonNullable<ReturnType<typeof buildSampler>>,
): Tick[] => {
	const out: Tick[] = []
	const seen = new Set<string>()
	for (const t of data.recentTrades ?? []) {
		if (t.usd_amount == null) continue
		const reserve = t.quote_reserve ?? (t.price != null ? S.reserveOf(t.price) : null)
		if (reserve == null) continue
		const key = `${t.ts}:${t.trader}:${t.side}`
		seen.add(key)
		out.push({
			key,
			pr: clamp(reserve / S.threshold, 0, 1),
			side: t.side,
			usd: t.usd_amount,
			ts: t.ts,
			creator: t.trader === data.creator,
			t0: null,
		})
	}
	const liveByKey = new Map(live.ticks.map((t) => [`${t.ts}:${t.trader}:${t.side}`, t]))
	for (const tick of out) {
		const l = liveByKey.get(tick.key)
		if (l) tick.t0 = l.t0
	}
	for (const [key, t] of liveByKey) {
		if (seen.has(key)) continue
		out.push({
			key,
			pr: clamp(t.progress, 0, 1),
			side: t.side,
			usd: t.usd,
			ts: t.ts,
			creator: t.trader === data.creator,
			t0: t.t0,
		})
	}
	return out.reverse()
}
