'use client'

import { type ReactNode, useEffect, useRef } from 'react'
import { useStream } from '@/components/stream-provider'
import type { Pipeline } from '@/lib/api'
import { useReducedMotion } from '@/lib/hooks'
import { fit, ms, type Palette, readPalette } from './canvas'

/*
 * Data path: source nodes → indexer → this UI, joined by the curve-motif bezier. Every dot is
 * one message: source dots are spawned at each source's real trailing-60 s rate from
 * /api/pipeline (Poisson arrivals at perMin), gRPC dots take the side colour of real recent
 * trades, and indexer → UI dots are the SSE events this tab actually receives.
 */

const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ')

type NodeKey = 'grpc' | 'blur' | 'api' | 'idx' | 'ui'
type Particle = { from: NodeKey; to: NodeKey; t0: number; dur: number; color: string; r: number }

/** Visual cap so a burst can't flood the canvas (dots per minute per source). */
const MAX_RATE = 1800
const MAX_PARTICLES = 500

const Metric = ({
	label,
	value,
	className,
}: {
	label: string
	value: ReactNode
	className?: string
}) => (
	<div className="flex min-w-0 flex-col gap-px">
		<span className="truncate text-[9px] tracking-[0.08em] text-ink-3">{label}</span>
		<span className={cx('text-[15px]', className)}>{value}</span>
	</div>
)

const Dot = ({ on, tone }: { on: boolean | null; tone: 'signal' | 'ink' }) =>
	on === false ? (
		<span className="size-[7px] rounded-full border-[1.5px] border-sell" title="disconnected" />
	) : (
		<span
			className={cx(
				'size-[7px] rounded-full',
				on == null ? 'bg-line' : tone === 'signal' ? 'bg-signal' : 'bg-ink-2',
			)}
			title={on ? 'connected' : undefined}
		/>
	)

const rate = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n)}/min`)

const SourceNode = ({
	node,
	kicker,
	kickerClass,
	title,
	hint,
	on,
	tone,
	strong,
	metrics,
}: {
	node: NodeKey
	kicker: string
	kickerClass?: string
	title: string
	hint: string
	on: boolean | null
	tone: 'signal' | 'ink'
	strong?: boolean
	metrics: ReactNode
}) => (
	<div
		data-node={node}
		className={cx(
			'relative z-[1] flex flex-col gap-2 border bg-bg px-4 py-3.5',
			strong ? 'border-ink-3' : 'border-line',
		)}
	>
		<div className="flex items-center justify-between gap-2">
			<span className={cx('font-mono text-[9.5px] tracking-label', kickerClass ?? 'text-ink-3')}>
				{kicker}
			</span>
			<Dot on={on} tone={tone} />
		</div>
		<span className="text-[15px] font-semibold">{title}</span>
		<span className="text-body-s text-ink-3">{hint}</span>
		<div className="grid grid-cols-2 gap-2 font-mono tabular-nums">{metrics}</div>
	</div>
)

export const DataPath = ({ pipeline }: { pipeline: Pipeline | null }) => {
	const { subscribe, latency } = useStream()
	const reduced = useReducedMotion()
	const rootRef = useRef<HTMLDivElement>(null)
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const pipeRef = useRef(pipeline)
	pipeRef.current = pipeline
	const reducedRef = useRef(reduced)
	reducedRef.current = reduced
	const particles = useRef<Particle[]>([])
	const sides = useRef<('buy' | 'sell')[]>([])
	const palette = useRef<Palette | null>(null)

	// indexer → UI: one dot per SSE event this tab receives; trade sides colour the gRPC dots.
	useEffect(
		() =>
			subscribe((event) => {
				if (reducedRef.current || document.hidden) return
				const C = palette.current
				if (!C) return
				let color = C.ink2
				if (event.type === 'trade') {
					sides.current.push(event.side)
					if (sides.current.length > 64) sides.current.shift()
					color = event.side === 'buy' ? C.buy : C.sell
				} else if (event.type === 'graduated') color = C.signal
				else if (event.type === 'risk') color = C.risk
				if (particles.current.length < MAX_PARTICLES)
					particles.current.push({
						from: 'idx',
						to: 'ui',
						t0: performance.now(),
						dur: 420,
						color,
						r: 2.6,
					})
			}),
		[subscribe],
	)

	useEffect(() => {
		let raf = 0
		const start = performance.now()
		const next: Record<'grpc' | 'blur' | 'api', number> = { grpc: start, blur: start, api: start }
		const anchors = () => {
			const root = rootRef.current
			if (!root) return null
			const rr = root.getBoundingClientRect()
			const A: Partial<Record<NodeKey, { l: number; r: number; y: number }>> = {}
			for (const el of root.querySelectorAll<HTMLElement>('[data-node]')) {
				const r = el.getBoundingClientRect()
				A[el.dataset.node as NodeKey] = {
					l: r.left - rr.left,
					r: r.right - rr.left,
					y: r.top - rr.top + r.height / 2,
				}
			}
			return A
		}
		const loop = () => {
			raf = requestAnimationFrame(loop)
			if (!palette.current?.ink) palette.current = readPalette()
			const C = palette.current
			const f = fit(canvasRef.current)
			const A = anchors()
			if (!f || !A) return
			const { ctx } = f
			const now = performance.now()
			const links: [NodeKey, NodeKey, string, number][] = [
				['grpc', 'idx', C.ink3, 1.6],
				['blur', 'idx', C.line, 1.2],
				['api', 'idx', C.line, 1.2],
				['idx', 'ui', C.ink3, 1.6],
			]
			const paths: Record<string, number[]> = {}
			for (const [a, b, color, lw] of links) {
				const p = A[a]
				const q = A[b]
				if (!p || !q) continue
				const x0 = p.r
				const x1 = q.l
				const dx = x1 - x0
				const path = [x0, p.y, x0 + dx * 0.6, p.y, x1 - dx * 0.6, q.y, x1, q.y]
				paths[a + b] = path
				ctx.strokeStyle = color
				ctx.lineWidth = lw
				ctx.beginPath()
				ctx.moveTo(path[0], path[1])
				ctx.bezierCurveTo(path[2], path[3], path[4], path[5], path[6], path[7])
				ctx.stroke()
			}
			if (reducedRef.current || document.hidden) {
				particles.current = []
				for (const k of Object.keys(next) as (keyof typeof next)[]) next[k] = now
				return
			}
			// Poisson arrivals at each source's measured rate.
			const p = pipeRef.current
			const sources: [keyof typeof next, number | undefined, number, () => string, number][] = [
				[
					'grpc',
					p?.grpc.connected ? p.grpc.perMin : 0,
					650,
					() => {
						const side = sides.current[(Math.random() * sides.current.length) | 0]
						return side === 'buy' ? C.buy : side === 'sell' ? C.sell : C.ink2
					},
					2.6,
				],
				['blur', p?.blur.connected ? p.blur.perMin : 0, 750, () => C.ink2, 2],
				['api', p?.dataApi.perMin, 850, () => C.ink3, 2],
			]
			for (const [key, perMin, dur, color, r] of sources) {
				const per = Math.min(perMin ?? 0, MAX_RATE)
				if (per <= 0) {
					next[key] = now
					continue
				}
				const mean = 60_000 / per
				if (next[key] < now - 1000) next[key] = now
				while (next[key] <= now && particles.current.length < MAX_PARTICLES) {
					particles.current.push({ from: key, to: 'idx', t0: next[key], dur, color: color(), r })
					next[key] += -Math.log(1 - Math.random()) * mean
				}
			}
			particles.current = particles.current.filter((q) => {
				const k = (now - q.t0) / q.dur
				if (k >= 1) return false
				const path = paths[q.from + q.to]
				if (!path || k < 0) return k < 0
				const u = 1 - k
				const x =
					u * u * u * path[0] +
					3 * u * u * k * path[2] +
					3 * u * k * k * path[4] +
					k * k * k * path[6]
				const y =
					u * u * u * path[1] +
					3 * u * u * k * path[3] +
					3 * u * k * k * path[5] +
					k * k * k * path[7]
				ctx.fillStyle = q.color
				ctx.beginPath()
				ctx.arc(x, y, q.r, 0, Math.PI * 2)
				ctx.fill()
				return true
			})
		}
		raf = requestAnimationFrame(loop)
		return () => cancelAnimationFrame(raf)
	}, [])

	const p = pipeline
	return (
		<div className="overflow-x-auto">
			<div
				ref={rootRef}
				className="relative grid min-w-[860px] grid-cols-[minmax(240px,1.15fr)_minmax(48px,0.45fr)_minmax(210px,1fr)_minmax(48px,0.45fr)_minmax(190px,0.9fr)] items-center py-8"
			>
				<canvas
					ref={canvasRef}
					className="pointer-events-none absolute inset-0 size-full"
					aria-hidden="true"
				/>
				<div className="flex flex-col gap-3.5">
					<SourceNode
						node="grpc"
						kicker="SOURCE OF TRUTH · gRPC"
						kickerClass="text-signal"
						title="Solami Yellowstone gRPC"
						hint="Decoded on-chain events"
						on={p ? p.grpc.connected : null}
						tone="signal"
						strong
						metrics={
							<>
								<Metric label="THROUGHPUT" value={rate(p?.grpc.perMin)} />
								<Metric label="SLOT SEEN → TX P50" value={ms(p?.grpc.latencyP50Ms)} />
							</>
						}
					/>
					<SourceNode
						node="blur"
						kicker="ENRICHMENT · WEBSOCKET"
						title="Solami Blur WebSocket"
						hint="Market cap, liquidity, metadata"
						on={p ? p.blur.connected : null}
						tone="ink"
						metrics={
							<>
								<Metric label="THROUGHPUT" value={rate(p?.blur.perMin)} />
								<Metric label="SLOT SEEN → BLUR P50" value={ms(p?.blur.latencyP50Ms)} />
							</>
						}
					/>
					<SourceNode
						node="api"
						kicker="ENRICHMENT · HTTP"
						title="Solami Data API"
						hint="Holders, metadata"
						on={p ? p.dataApi.connected : null}
						tone="ink"
						metrics={
							<>
								<Metric label="REQUESTS" value={rate(p?.dataApi.perMin)} />
								<Metric label="ROUND TRIP P50" value={ms(p?.dataApi.latencyP50Ms)} />
							</>
						}
					/>
				</div>
				<div />
				<div
					data-node="idx"
					className="relative z-[1] flex flex-col gap-2.5 border border-line bg-bg-2 px-5 py-[18px]"
				>
					<span className="font-mono text-[9.5px] tracking-label text-ink-3">INDEXER</span>
					<span className="font-display text-display-m font-bold">dbc-radar indexer</span>
					<span className="text-body-s text-ink-3">Pools, trades, holders, risk score</span>
					<div className="grid grid-cols-2 gap-2 font-mono tabular-nums">
						<Metric label="MSGS IN" value={rate(p?.indexer.perMin)} />
						<Metric label="PROCESS P50" value={ms(p?.indexer.processP50Ms)} />
					</div>
				</div>
				<div />
				<div
					data-node="ui"
					className="relative z-[1] flex flex-col gap-2.5 border border-line bg-bg px-5 py-[18px]"
				>
					<span className="font-mono text-[9.5px] tracking-label text-ink-3">
						THIS UI · SSE{p ? ` · ${p.sse.clients} OPEN` : ''}
					</span>
					<span className="font-display text-display-m font-bold">DBC Radar</span>
					<div className="grid grid-cols-2 gap-2 font-mono tabular-nums">
						<Metric label="PUSHES" value={rate(p?.sse.pushesPerMin)} />
						<Metric label="SLOT → SSE PUSH" value={ms(p?.sse.slotToPushP50Ms)} />
						<Metric label="→ THIS BROWSER" value={ms(latency.receiveP50Ms)} />
						<Metric label="→ PAINTED" value={ms(latency.paintP50Ms)} className="text-signal" />
					</div>
					<span className="font-mono text-[9px] leading-snug text-ink-3">
						Browser p50s measured in this tab, clock synced to the indexer
						{latency.rttMs == null ? '' : ` ±${Math.round(latency.rttMs / 2)}ms`}. Painted includes
						the feed's 4 Hz batching.
					</span>
				</div>
			</div>
		</div>
	)
}
