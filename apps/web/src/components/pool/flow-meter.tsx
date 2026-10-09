'use client'

import { useEffect, useRef, useState } from 'react'
import type { PoolDetail } from '@/lib/api'
import { pct, usd } from '@/lib/format'
import { alpha, type FlowBucket, fitCanvas, flowBuckets, type Palette, readPalette } from './model'

type Win = '5m' | '1h'

/**
 * Flow: buy/sell split bar with a verdict, then per-bucket bars (buys filled above the axis,
 * sells hollow below, √ scale) with the cumulative net line, and totals. 5m = 10 s buckets,
 * 1h = 1 min buckets, both from the indexer.
 */
export const FlowMeter = ({
	data,
	now,
	className,
}: {
	data: PoolDetail
	now: number
	className?: string
}) => {
	const [win, setWin] = useState<Win>('5m')
	const buckets = flowBuckets(data, win, now)
	const buys = buckets.reduce((a, b) => a + b.buyUsd, 0)
	const sells = buckets.reduce((a, b) => a + b.sellUsd, 0)
	const total = buys + sells
	const bp = total ? buys / total : 0.5
	const net = buys - sells
	const verdict = !total
		? 'no trades in window'
		: bp > 0.6
			? 'buy pressure'
			: bp < 0.4
				? 'sell pressure'
				: 'balanced'

	const canvasRef = useRef<HTMLCanvasElement>(null)
	const drawRef = useRef({ buckets, win })
	drawRef.current = { buckets, win }

	useEffect(() => {
		let palette = readPalette()
		const redraw = () =>
			drawFlow(canvasRef.current, drawRef.current.buckets, drawRef.current.win, palette)
		const observer = new ResizeObserver(redraw)
		if (canvasRef.current) observer.observe(canvasRef.current)
		const themeObserver = new MutationObserver(() => {
			palette = readPalette()
			redraw()
		})
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['data-theme'],
		})
		redraw()
		return () => {
			observer.disconnect()
			themeObserver.disconnect()
		}
	}, [])

	// Redraw whenever a new snapshot or window arrives (the bars only change with data).
	useEffect(() => {
		drawFlow(canvasRef.current, buckets, win, readPalette())
	})

	return (
		<section className={`min-w-0 border-t border-line ${className ?? ''}`}>
			<header className="flex items-baseline justify-between gap-3 pt-3 pb-2 sm:pt-4 sm:pb-3">
				<h2 className="font-display text-[18px] font-bold tracking-[0.03em] uppercase sm:text-section">
					Flow
					<span className="sm:hidden"> · {win}</span>
				</h2>
				<div
					className="flex border border-line font-mono text-data-s"
					role="group"
					aria-label="Flow window"
				>
					{(['5m', '1h'] as const).map((k) => (
						<button
							key={k}
							type="button"
							aria-pressed={win === k}
							onClick={() => setWin(k)}
							className={`px-2.5 py-1 transition-colors ${win === k ? 'bg-ink text-bg' : 'text-ink-2 hover:text-ink'}`}
						>
							{k}
						</button>
					))}
				</div>
			</header>
			<div className="num flex items-baseline justify-between pb-1.5 text-[10.5px] sm:pb-2 sm:text-data-s">
				<span className="text-buy">▲ BUY {pct(bp, 0)}</span>
				<span className="text-ink-3">{verdict}</span>
				<span className="text-sell">{pct(1 - bp, 0)} SELL ▼</span>
			</div>
			<div className="flex h-2 gap-0.5 sm:h-2.5">
				<div
					className={`transition-[width] duration-600 ease-out ${total ? 'bg-buy' : 'bg-line'}`}
					style={{ width: `${(bp * 100).toFixed(1)}%` }}
				/>
				<div
					className={`flex-1 ${total ? 'bg-[repeating-linear-gradient(90deg,var(--color-sell)_0_3px,transparent_3px_5px)]' : 'bg-[repeating-linear-gradient(90deg,var(--color-line)_0_3px,transparent_3px_5px)]'}`}
				/>
			</div>
			<canvas
				ref={canvasRef}
				className="mt-4 hidden h-[230px] w-full sm:block"
				role="img"
				aria-label={`Flow ${win}: buys ${usd(buys)}, sells ${usd(sells)}`}
			/>
			<div className="num flex flex-wrap justify-between gap-x-4 gap-y-1.5 pt-2.5 text-data-s text-ink-2">
				<span>buys {usd(buys)}</span>
				<span>sells {usd(sells)}</span>
				<span>
					net{' '}
					<span className={net >= 0 ? 'text-buy' : 'text-sell'}>
						{net >= 0 ? '+' : '−'}
						{usd(Math.abs(net))}
					</span>
				</span>
			</div>
		</section>
	)
}

const drawFlow = (
	canvas: HTMLCanvasElement | null,
	buckets: FlowBucket[],
	win: Win,
	C: Palette,
) => {
	const f = fitCanvas(canvas)
	if (!f) return
	const { ctx, w, h } = f
	const n = buckets.length || 1
	const mid = h / 2 - 6
	const max = Math.max(1, ...buckets.map((b) => Math.max(b.buyUsd, b.sellUsd)))
	const bw = w / n
	ctx.strokeStyle = C.line
	ctx.lineWidth = 1
	ctx.beginPath()
	ctx.moveTo(0, Math.round(mid) + 0.5)
	ctx.lineTo(w, Math.round(mid) + 0.5)
	ctx.stroke()
	buckets.forEach((b, i) => {
		const x = i * bw + 1
		const ww = Math.max(1, bw - 2)
		const hb = Math.sqrt(b.buyUsd / max) * (mid - 6)
		const hs = Math.sqrt(b.sellUsd / max) * (mid - 6)
		ctx.fillStyle = C.buy
		if (hb > 0) ctx.fillRect(x, mid - hb, ww, hb)
		ctx.strokeStyle = C.sell
		ctx.lineWidth = 1
		if (hs > 1) ctx.strokeRect(x + 0.5, mid + 1.5, ww - 1, hs - 1)
		else if (hs > 0) {
			ctx.fillStyle = C.sell
			ctx.fillRect(x, mid + 1, ww, 1)
		}
	})
	let cum = 0
	const pts = buckets.map((b) => {
		cum += b.buyUsd - b.sellUsd
		return cum
	})
	const cm = Math.max(1, ...pts.map(Math.abs))
	ctx.strokeStyle = C.ink
	ctx.lineWidth = 1.5
	ctx.beginPath()
	pts.forEach((v, i) => {
		const x = i * bw + bw / 2
		const y = mid - (v / cm) * (mid - 10)
		if (i) ctx.lineTo(x, y)
		else ctx.moveTo(x, y)
	})
	ctx.stroke()
	ctx.font = `500 9.5px ${C.mono}`
	ctx.fillStyle = C.ink3
	ctx.textAlign = 'left'
	ctx.fillText(win === '1h' ? '−60m' : '−5m', 0, h - 2)
	ctx.textAlign = 'right'
	ctx.fillText('now', w, h - 2)
	ctx.textAlign = 'center'
	ctx.fillText('— cumulative net', w / 2, h - 2)
	if (!buckets.some((b) => b.buyUsd || b.sellUsd)) {
		ctx.fillStyle = alpha(C.ink3, 0.9)
		ctx.fillText(`no trades in the last ${win === '1h' ? 'hour' : '5 minutes'}`, w / 2, mid - 12)
	}
}
