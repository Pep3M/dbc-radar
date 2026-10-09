'use client'

import { type ReactNode, useEffect, useRef } from 'react'
import type { Pipeline } from '@/lib/api'
import { fit, MONO, ms, type Palette, readPalette } from './canvas'

/*
 * gRPC vs Blur, per signature: each sample is one DBC transaction; the filled amber dot is
 * slot seen → gRPC arrival, the hollow ring is slot seen → Blur arrival for the same
 * signature (log scale). X is server time, extrapolated between polls so the chart scrolls.
 */

const LO = 10
const HI = 3000
const MIN_WINDOW = 20_000
const MAX_WINDOW = 120_000

type Anchor = { serverNow: number; clientAt: number }

export const windowMs = (pipeline: Pipeline | null) => {
	const s = pipeline?.samples
	if (!pipeline || !s?.length) return MIN_WINDOW
	const span = pipeline.startedAt + pipeline.uptimeMs - s[0].ts
	return Math.min(MAX_WINDOW, Math.max(MIN_WINDOW, Math.ceil(span / 10_000) * 10_000))
}

const Row = ({ label, children, big }: { label: string; children: ReactNode; big?: boolean }) => (
	<div className="flex items-baseline justify-between gap-3 border-b border-line-soft py-3">
		<span className={big ? 'text-[10px] tracking-[0.08em] text-ink-3' : 'text-data text-ink-3'}>
			{label}
		</span>
		{children}
	</div>
)

const hms = (value: number | null | undefined) => {
	if (value == null) return '—'
	const s = Math.floor(value / 1000)
	return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${s % 60}s`
}

export const LatencyChart = ({ pipeline }: { pipeline: Pipeline | null }) => {
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const data = useRef<{ pipeline: Pipeline | null; anchor: Anchor | null }>({
		pipeline: null,
		anchor: null,
	})

	useEffect(() => {
		data.current = {
			pipeline,
			anchor: pipeline
				? { serverNow: pipeline.startedAt + pipeline.uptimeMs, clientAt: performance.now() }
				: null,
		}
	}, [pipeline])

	useEffect(() => {
		let raf = 0
		let C: Palette | null = null
		const loop = () => {
			raf = requestAnimationFrame(loop)
			if (!C?.ink) C = readPalette()
			const f = fit(canvasRef.current)
			if (!f) return
			const { ctx, w, h } = f
			const { pipeline: p, anchor } = data.current
			const padL = 44
			const padB = 18
			const lo = Math.log10(LO)
			const hi = Math.log10(HI)
			const Y = (v: number) =>
				h - padB - ((Math.log10(Math.min(HI, Math.max(LO, v))) - lo) / (hi - lo)) * (h - padB - 8)
			ctx.font = `500 9.5px ${MONO}`
			ctx.textAlign = 'right'
			for (const v of [10, 30, 100, 300, 1000, 3000]) {
				const y = Math.round(Y(v)) + 0.5
				ctx.strokeStyle = C.lineSoft
				ctx.lineWidth = 1
				ctx.beginPath()
				ctx.moveTo(padL, y)
				ctx.lineTo(w, y)
				ctx.stroke()
				ctx.fillStyle = C.ink3
				ctx.fillText(v >= 1000 ? `${v / 1000}s` : `${v}ms`, padL - 8, y + 3)
			}
			ctx.textAlign = 'left'
			if (!p || !anchor || p.samples.length === 0) return
			const now = anchor.serverNow + (performance.now() - anchor.clientAt)
			const span = windowMs(p)
			const X = (t: number) => padL + (1 - (now - t) / span) * (w - padL - 6)
			for (const s of p.samples) {
				const x = X(s.ts)
				if (x < padL) continue
				const yg = Y(s.grpcMs)
				if (s.blurMs != null) {
					const yb = Y(s.blurMs)
					ctx.strokeStyle = C.line
					ctx.lineWidth = 1
					ctx.beginPath()
					ctx.moveTo(x, yg)
					ctx.lineTo(x, yb)
					ctx.stroke()
					ctx.strokeStyle = C.ink2
					ctx.lineWidth = 1.4
					ctx.beginPath()
					ctx.arc(x, yb, 3, 0, Math.PI * 2)
					ctx.stroke()
				}
				ctx.fillStyle = C.signal
				ctx.beginPath()
				ctx.arc(x, yg, 3, 0, Math.PI * 2)
				ctx.fill()
			}
		}
		raf = requestAnimationFrame(loop)
		return () => cancelAnimationFrame(raf)
	}, [])

	const p = pipeline
	const matched = p?.samples.filter((s) => s.blurMs != null).length ?? 0
	const empty = !p || p.samples.length === 0
	return (
		<div className="flex flex-wrap gap-8 pt-5">
			<div className="relative min-w-0 flex-[999_1_640px]">
				<canvas
					ref={canvasRef}
					className="block h-[260px] w-full"
					aria-label="Latency per signature, gRPC versus Blur, log scale"
					role="img"
				/>
				{empty && (
					<p className="absolute inset-x-11 top-1/2 -translate-y-1/2 text-center font-mono text-data text-ink-3">
						{!p
							? 'Waiting for pipeline metrics…'
							: p.source !== 'grpc'
								? `Indexer is running on "${p.source}": per-signature gRPC timing needs the gRPC source.`
								: 'Waiting for the first DBC transactions on the gRPC stream…'}
					</p>
				)}
			</div>
			<div className="flex flex-[1_1_280px] flex-col border-t border-line-soft font-mono tabular-nums">
				<Row label="gRPC P50" big>
					<span className="font-display text-[34px] leading-none font-bold text-signal">
						{ms(p?.grpc.latencyP50Ms)}
					</span>
				</Row>
				<Row label="BLUR P50" big>
					<span className="font-display text-[34px] leading-none font-bold">
						{ms(p?.blur.latencyP50Ms)}
					</span>
				</Row>
				<Row label="gRPC arrived first">
					<span className="text-data">
						{p?.grpcFirstShare != null
							? `${Math.round(p.grpcFirstShare * 100)}% of ${matched}`
							: '—'}
					</span>
				</Row>
				<Row label="gRPC connected for">
					<span className="text-data">{hms(p?.grpc.connectedForMs)}</span>
				</Row>
				<Row label="Indexer uptime">
					<span className="text-data">{hms(p?.uptimeMs)}</span>
				</Row>
				<Row label="Reconnects · gRPC / Blur">
					<span className="text-data">
						{p ? `${p.grpc.reconnects} / ${p.blur.reconnects}` : '—'}
					</span>
				</Row>
			</div>
		</div>
	)
}
