'use client'

import { useRouter } from 'next/navigation'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { progressPct, seconds, usd } from '@/lib/format'
import { useNow, useReducedMotion } from '@/lib/hooks'
import { FLAG_LABEL, RISK_HIGH } from '../ui'
import {
	type BlipHit,
	type Palette,
	paintScope,
	paintStrip,
	readPalette,
	type ScopeModel,
} from './model'

type Hover = { id: string; x: number; y: number; w: number }

const HIT_RADIUS = 14

/**
 * Radar hero. One <canvas> repainted every animation frame straight from the mutable `model`
 * (React only re-renders for the hover card). `variant="strip"` is the 132px linear version
 * used under 640px. DPR- and resize-aware; pauses while hidden (zero size).
 */
export const Scope = ({
	model,
	angleLegend,
	onHoverChange,
	offline,
	lastEventAgeMs,
	variant = 'scope',
}: {
	model: ScopeModel
	/** e.g. "age since launch · log scale · full turn = 24h". */
	angleLegend: string
	/** Blip under the pointer changed (cross-highlights the table row). */
	onHoverChange?: (pool: string | null) => void
	offline: boolean
	lastEventAgeMs: number | null | undefined
	variant?: 'scope' | 'strip'
}) => {
	const router = useRouter()
	const reduced = useReducedMotion()
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const hitsRef = useRef<BlipHit[]>([])
	const [hover, setHover] = useState<Hover | null>(null)
	const live = useRef({ reduced, offline, highlight: null as string | null })
	live.current = { reduced, offline, highlight: hover?.id ?? null }

	useEffect(() => {
		const canvas = canvasRef.current
		const ctx = canvas?.getContext('2d')
		if (!canvas || !ctx) return
		let C: Palette = readPalette()
		let font = getComputedStyle(canvas).fontFamily || 'monospace'
		const size = { w: canvas.clientWidth, h: canvas.clientHeight, dpr: 0 }
		const resize = new ResizeObserver(([entry]) => {
			size.w = entry.contentRect.width
			size.h = entry.contentRect.height
		})
		resize.observe(canvas)
		// Theme switch (`data-theme` on <html>): re-resolve the colour tokens.
		const theme = new MutationObserver(() => {
			C = readPalette()
			font = getComputedStyle(canvas).fontFamily || 'monospace'
		})
		theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
		let frame = 0
		let last = 0
		const draw = (ts: number) => {
			frame = requestAnimationFrame(draw)
			const dt = Math.min(64, ts - (last || ts))
			last = ts
			const { w, h } = size
			if (!w || !h) return
			const dpr = window.devicePixelRatio || 1
			const pw = Math.round(w * dpr)
			const ph = Math.round(h * dpr)
			if (canvas.width !== pw || canvas.height !== ph) {
				canvas.width = pw
				canvas.height = ph
			}
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
			ctx.clearRect(0, 0, w, h)
			if (!C.ink) C = readPalette()
			const opts = {
				C,
				font,
				reduced: live.current.reduced,
				offline: live.current.offline,
				highlight: live.current.highlight,
				ts,
				dt,
				now: Date.now(),
			}
			hitsRef.current =
				variant === 'strip' ? paintStrip(ctx, w, h, model, opts) : paintScope(ctx, w, model, opts)
		}
		frame = requestAnimationFrame(draw)
		return () => {
			cancelAnimationFrame(frame)
			resize.disconnect()
			theme.disconnect()
		}
	}, [model, variant])

	const nearest = (clientX: number, clientY: number, radius: number) => {
		const canvas = canvasRef.current
		if (!canvas) return null
		const r = canvas.getBoundingClientRect()
		const x = clientX - r.left
		const y = clientY - r.top
		let best: BlipHit | null = null
		let bd = radius * radius
		for (const b of hitsRef.current) {
			const d = (b.x - x) ** 2 + (b.y - y) ** 2
			if (d < bd) {
				bd = d
				best = b
			}
		}
		return best ? { ...best, w: r.width } : null
	}

	const open = (id: string) => router.push(`/pool/${id}`)

	if (variant === 'strip') {
		return (
			<div>
				<canvas
					ref={canvasRef}
					aria-label="Curve strip: every live DBC pool by curve progress and age"
					role="img"
					className="block h-[132px] w-full cursor-pointer bg-bg-2 font-mono"
					onClick={(e) => {
						const hit = nearest(e.clientX, e.clientY, 22)
						if (hit) open(hit.id)
					}}
				/>
				<div className="flex justify-between pt-1.5 font-mono text-label text-ink-3">
					<span>x · curve progress</span>
					<span>rows · age (log)</span>
					<span className="text-signal">edge = graduation</span>
				</div>
			</div>
		)
	}

	return (
		<div className="flex min-w-0 flex-col gap-3.5">
			<div className="relative mx-auto aspect-square w-full max-w-[660px]">
				<div
					aria-hidden="true"
					className="absolute inset-10 rounded-full"
					style={{
						background:
							'radial-gradient(circle at 50% 50%, var(--color-bg-2) 0%, var(--color-bg) 72%)',
					}}
				/>
				<canvas
					ref={canvasRef}
					role="img"
					aria-label="Radar scope: every live DBC pool. Radius is curve progress, angle is age, size is 5 minute volume."
					className="absolute inset-0 block size-full cursor-crosshair font-mono"
					onMouseMove={(e) => {
						const hit = nearest(e.clientX, e.clientY, HIT_RADIUS)
						if ((hit?.id ?? null) !== (hover?.id ?? null)) {
							setHover(hit)
							onHoverChange?.(hit?.id ?? null)
						}
					}}
					onMouseLeave={() => {
						setHover(null)
						onHoverChange?.(null)
					}}
					onClick={() => hover && open(hover.id)}
				/>
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-10 rounded-full"
					style={{
						background:
							'repeating-linear-gradient(0deg, transparent 0 2px, color-mix(in oklch, var(--color-ink) 3%, transparent) 2px 3px)',
					}}
				/>
				{offline && (
					<div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
						<span className="font-display text-[44px] leading-none font-extrabold tracking-[0.08em] text-sell">
							SIGNAL LOST
						</span>
						<span className="bg-bg px-1.5 py-0.5 font-mono text-data text-ink-2">
							indexer offline · reconnecting
							{lastEventAgeMs != null && ` · last event ${seconds(lastEventAgeMs)} ago`}
						</span>
					</div>
				)}
				{hover && <HoverCard model={model} hover={hover} />}
			</div>
			<Legend angle={angleLegend} />
		</div>
	)
}

const HoverCard = ({ model, hover }: { model: ScopeModel; hover: Hover }) => {
	useNow(500)
	const b = model.blips.get(hover.id)
	if (!b) return null
	const high = b.score >= RISK_HIGH
	const left = hover.x > hover.w * 0.58 ? hover.x - 256 : hover.x + 20
	const top = Math.max(0, Math.min(hover.y - 24, hover.w - 190))
	return (
		<div
			className="num pointer-events-none absolute z-10 flex w-[236px] flex-col gap-2.5 border border-line bg-bg px-3.5 py-3 text-data-s shadow-float"
			style={{ left, top }}
		>
			<div className="flex items-center justify-between gap-2">
				<span className="truncate font-display text-[24px] leading-none font-bold">
					{b.symbol ?? `${b.pool.slice(0, 4)}…${b.pool.slice(-4)}`}
				</span>
				{b.launchpad && (
					<span className="shrink-0 border border-line px-1 py-px text-[9px] tracking-[0.06em] text-ink-3 uppercase">
						{b.launchpad}
					</span>
				)}
			</div>
			<div className="grid grid-cols-2 gap-x-3 gap-y-2">
				<CardField label="CURVE">
					<span className={b.progress >= 0.8 ? 'text-signal' : 'text-ink'}>
						{progressPct(b.progress)}
					</span>
				</CardField>
				<CardField label="VOL 5M">{usd(b.vol5)}</CardField>
				<CardField label="MCAP">{usd(b.mcap)}</CardField>
				<CardField label="RISK">
					<span className={high ? 'text-risk' : 'text-ink'}>
						{b.score}
						{high && ' ◆'}
					</span>
				</CardField>
			</div>
			<span className="text-[10px] text-ink-3">
				{b.flags.length ? b.flags.map((f) => FLAG_LABEL[f]).join(' · ') : 'no flags from flow'}
			</span>
			<span className="text-label tracking-label text-signal">CLICK TO OPEN POOL →</span>
		</div>
	)
}

const CardField = ({ label, children }: { label: string; children: ReactNode }) => (
	<div className="flex flex-col gap-px">
		<span className="text-[9px] tracking-[0.08em] text-ink-3">{label}</span>
		<span>{children}</span>
	</div>
)

const Legend = ({ angle }: { angle: string }) => (
	<div className="flex flex-wrap justify-center gap-x-[22px] gap-y-1.5 font-mono text-[10.5px] tracking-[0.03em] text-ink-3">
		<span>
			RADIUS · curve progress, <span className="text-signal">outer ring = graduation</span>
		</span>
		<span>ANGLE · {angle}, clockwise from now</span>
		<span>SIZE · volume 5m</span>
		<span className="flex gap-2">
			<span>● clean</span>
			<span>◇ flagged</span>
			<span className="text-risk">◆ risk ≥ 40</span>
		</span>
		<span className="flex gap-2">
			<span className="text-buy">▲ buy pushes out</span>
			<span className="text-sell">▼ sell pulls in</span>
		</span>
	</div>
)
