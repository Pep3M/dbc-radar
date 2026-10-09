'use client'

import { type ReactNode, useEffect, useRef, useState } from 'react'
import { useStream } from '@/components/stream-provider'
import { FLAG_LABEL, Kicker } from '@/components/ui'
import type { LiveEvent } from '@/lib/api'
import { shortAddress, usd } from '@/lib/format'
import { FLUSH_MS } from '@/lib/hooks'
import { alpha, fit, MONO, median, ms, type Palette, readPalette } from './canvas'
import { emptyRpcRun, type RpcRun, runPublicRpc } from './public-rpc'

/*
 * Hero race, measured live in the visitor's browser: the left panel polls the public RPC
 * like a naive client (see public-rpc.ts), the right panel counts the DBC events our SSE
 * pushes to this tab in the same 30 s. Both models are mutable refs drawn by one rAF loop;
 * React re-renders at 4 Hz for the counters and logs.
 */

const RUN_MS = 30_000
const MAX_LOG = 9

const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ')

type SolKind = 'buy' | 'sell' | 'new' | 'grad' | 'risk'
type SolLog = { id: number; t: number; kind: SolKind; text: string; code: string }
type SolRun = { n: number; trace: { t: number; kind: SolKind; usd: number }[]; log: SolLog[] }

const emptySolRun = (): SolRun => ({ n: 0, trace: [], log: [] })

const describe = (
	event: Exclude<LiveEvent, { type: 'alert' }>,
): { kind: SolKind; text: string; usd: number } => {
	const name = 'symbol' in event && event.symbol ? event.symbol : shortAddress(event.pool)
	switch (event.type) {
		case 'trade':
			return {
				kind: event.side,
				text: `swap ${event.side === 'buy' ? '▲' : '▼'} ${usd(event.usdAmount)} · ${name}`,
				usd: event.usdAmount ?? 0,
			}
		case 'pool_created':
			return { kind: 'new', text: `launch · ${name}`, usd: 0 }
		case 'graduated':
			return { kind: 'grad', text: `graduated · ${name} → DAMM v2`, usd: 0 }
		case 'risk':
			return { kind: 'risk', text: `risk ◆ ${FLAG_LABEL[event.flag]} · ${name}`, usd: 0 }
	}
}

const SOL_COLOR: Record<SolKind, string> = {
	buy: 'text-buy',
	sell: 'text-sell',
	new: 'text-ink',
	grad: 'text-signal',
	risk: 'text-risk',
}

const RPC_COLOR: Record<RpcRun['log'][number]['kind'], string> = {
	ok: 'text-ink-2',
	sigs: 'text-ink-3',
	throttled: 'text-risk',
	error: 'text-sell',
	blocked: 'text-sell',
}

const sec = (t: number) => `${(t / 1000).toFixed(1).padStart(4, '0')}s`

type Model = { t0: number; rpc: RpcRun; sol: SolRun }

const drawTrace = (
	canvas: HTMLCanvasElement | null,
	kind: 'rpc' | 'sol',
	model: Model,
	C: Palette,
	now: number,
) => {
	const f = fit(canvas)
	if (!f) return
	const { ctx, w, h } = f
	const rt = Math.min(now - model.t0, RUN_MS)
	const mid = Math.round(h / 2 - 8) + 0.5
	const X = (t: number) => (t / RUN_MS) * (w - 1) + 0.5
	ctx.lineWidth = 1
	ctx.strokeStyle = C.lineSoft
	for (let s = 0; s <= 30; s += 5) {
		const x = Math.round(X(s * 1000)) + 0.5
		ctx.beginPath()
		ctx.moveTo(x, 0)
		ctx.lineTo(x, h - 16)
		ctx.stroke()
	}
	ctx.strokeStyle = C.line
	ctx.beginPath()
	ctx.moveTo(0, mid)
	ctx.lineTo(w, mid)
	ctx.stroke()
	if (kind === 'sol') {
		for (const e of model.sol.trace) {
			const x = X(e.t)
			if (e.kind === 'buy' || e.kind === 'sell') {
				const hh = Math.min(mid - 4, 6 + Math.log10(1 + e.usd) * 12)
				ctx.strokeStyle = e.kind === 'buy' ? C.buy : C.sell
				ctx.lineWidth = 1.4
				ctx.beginPath()
				ctx.moveTo(x, mid)
				ctx.lineTo(x, e.kind === 'buy' ? mid - hh : mid + hh)
				ctx.stroke()
			} else {
				ctx.fillStyle = e.kind === 'grad' ? C.signal : e.kind === 'risk' ? C.risk : C.ink
				ctx.beginPath()
				ctx.arc(x, mid, 2.6, 0, Math.PI * 2)
				ctx.fill()
			}
		}
	} else {
		const P = model.rpc
		if (P.throttledAt != null) {
			ctx.fillStyle = alpha(C.risk, 0.1)
			ctx.fillRect(X(P.throttledAt), 0, X(rt) - X(P.throttledAt), h - 16)
		}
		for (const e of P.trace) {
			const x = X(e.t)
			if (e.kind === 'ok') {
				ctx.strokeStyle = C.ink
				ctx.lineWidth = 1.6
				ctx.beginPath()
				ctx.moveTo(x, mid)
				ctx.lineTo(x, mid - 26)
				ctx.stroke()
			} else {
				ctx.fillStyle = e.kind === 'throttled' ? C.risk : C.sell
				ctx.fillRect(x - 3, mid + 6, 6, 14)
			}
		}
		if (P.throttledAt != null) {
			ctx.fillStyle = C.risk
			ctx.font = `600 10px ${MONO}`
			ctx.textAlign = 'left'
			ctx.fillText('HTTP 429 · THROTTLED', Math.min(X(P.throttledAt) + 6, w - 130), 12)
		}
	}
	ctx.font = `500 9.5px ${MONO}`
	ctx.fillStyle = C.ink3
	for (let s = 0; s <= 30; s += 10) {
		ctx.textAlign = s === 0 ? 'left' : s === 30 ? 'right' : 'center'
		ctx.fillText(`${s}s`, X(s * 1000), h - 2)
	}
	ctx.textAlign = 'left'
	if (rt < RUN_MS) {
		ctx.strokeStyle = C.signal
		ctx.lineWidth = 1.5
		ctx.beginPath()
		ctx.moveTo(X(rt), 0)
		ctx.lineTo(X(rt), h - 16)
		ctx.stroke()
	}
}

const ChipStatus = ({
	tone,
	children,
}: {
	tone: 'outline' | 'ink' | 'risk' | 'sell'
	children: ReactNode
}) => (
	<span
		className={cx(
			'flex-none border px-2 py-1 font-mono text-[10.5px] font-semibold tracking-[0.08em]',
			tone === 'outline' && 'border-line text-ink-2',
			tone === 'ink' && 'border-ink bg-ink text-bg',
			tone === 'risk' && 'border-risk bg-risk text-risk-ink',
			tone === 'sell' && 'border-sell text-sell',
		)}
	>
		{children}
	</span>
)

const Panel = ({
	kicker,
	title,
	chip,
	count,
	countClass,
	unit,
	hint,
	canvasRef,
	log,
	foot,
	footClass,
	note,
}: {
	kicker: ReactNode
	title: ReactNode
	chip: ReactNode
	count: number
	countClass?: string
	unit: string
	hint: ReactNode
	canvasRef: React.RefObject<HTMLCanvasElement | null>
	log: ReactNode
	foot: ReactNode
	footClass?: string
	note?: ReactNode
}) => (
	<div className="flex min-w-0 flex-col gap-[18px] bg-bg px-4 py-5 sm:px-[26px] sm:py-6">
		<div className="flex items-start justify-between gap-3">
			<div className="flex min-w-0 flex-col gap-[3px]">
				<span className="font-mono text-[10px] tracking-[0.12em] text-ink-3">{kicker}</span>
				<span className="text-[15px] font-semibold">{title}</span>
			</div>
			{chip}
		</div>
		<div className="flex items-end gap-[18px]">
			<span
				className={cx(
					'font-display text-[clamp(96px,10vw,148px)] leading-[0.8] font-extrabold tabular-nums',
					countClass,
				)}
			>
				{count}
			</span>
			<div className="flex flex-col gap-1 pb-1.5 font-mono text-data text-ink-2">
				<span>{unit}</span>
				<span className="text-ink-3">{hint}</span>
			</div>
		</div>
		<canvas ref={canvasRef} className="block h-[110px] w-full" aria-hidden="true" />
		<div className="flex h-[198px] flex-col overflow-hidden font-mono text-data-s tabular-nums">
			{log}
		</div>
		<div className="flex flex-col gap-1 border-t border-line-soft pt-3 font-mono text-[11.5px]">
			<span className={footClass}>{foot}</span>
			{note && <span className="text-[10.5px] text-ink-3">{note}</span>}
		</div>
	</div>
)

const LogRow = ({
	t,
	text,
	code,
	className,
	codeClass,
}: {
	t: number
	text: string
	code: string
	className: string
	codeClass?: string
}) => (
	<div
		className={cx(
			'grid h-[22px] flex-none grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-2.5',
			className,
		)}
	>
		<span className="text-ink-3">{sec(t)}</span>
		<span className="truncate">{text}</span>
		<span className={codeClass}>{code}</span>
	</div>
)

export const Race = ({ headline }: { headline: ReactNode }) => {
	const { subscribe, connected, health } = useStream()
	const [runKey, setRunKey] = useState(0)
	const [elapsed, setElapsed] = useState(0)
	const [, setFlush] = useState(0)
	const model = useRef<Model>({ t0: 0, rpc: emptyRpcRun(), sol: emptySolRun() })
	const rpcCanvas = useRef<HTMLCanvasElement>(null)
	const solCanvas = useRef<HTMLCanvasElement>(null)

	// One run per mount / REPLAY. Never auto-loops: each run sends real requests.
	useEffect(() => {
		void runKey
		const m: Model = { t0: performance.now(), rpc: emptyRpcRun(), sol: emptySolRun() }
		model.current = m
		setElapsed(0)
		const controller = new AbortController()
		runPublicRpc({
			run: m.rpc,
			t0: m.t0,
			durationMs: RUN_MS,
			signal: controller.signal,
			onChange: () => {},
		})
		const unsubscribe = subscribe((event) => {
			if (event.type === 'alert') return
			const t = performance.now() - m.t0
			if (t > RUN_MS) return
			const d = describe(event)
			m.sol.n++
			m.sol.trace.push({ t, kind: d.kind, usd: d.usd })
			m.sol.log.unshift({
				id: m.sol.n,
				t,
				kind: d.kind,
				text: d.text,
				code: shortAddress(event.pool),
			})
			if (m.sol.log.length > MAX_LOG) m.sol.log.length = MAX_LOG
		})
		const timer = setInterval(() => {
			const t = Math.min(performance.now() - m.t0, RUN_MS)
			setElapsed(t)
			setFlush((n) => n + 1)
			if (t >= RUN_MS) {
				clearInterval(timer)
				controller.abort()
			}
		}, FLUSH_MS)
		return () => {
			controller.abort()
			unsubscribe()
			clearInterval(timer)
		}
	}, [runKey, subscribe])

	useEffect(() => {
		let raf = 0
		let C: Palette | null = null
		const loop = () => {
			raf = requestAnimationFrame(loop)
			if (!C?.ink) C = readPalette()
			const now = performance.now()
			drawTrace(rpcCanvas.current, 'rpc', model.current, C, now)
			drawTrace(solCanvas.current, 'sol', model.current, C, now)
		}
		raf = requestAnimationFrame(loop)
		return () => cancelAnimationFrame(raf)
	}, [])

	const { rpc, sol } = model.current
	const done = elapsed >= RUN_MS
	const perMin = (n: number) => (elapsed > 1500 ? Math.round((n / elapsed) * 60_000) : null)
	const rpcRate = perMin(rpc.delivered)
	const solRate = perMin(sol.n)
	const lastThrottle = rpc.trace.findLast((e) => e.kind === 'throttled')
	const throttledNow = rpc.backingOff || (lastThrottle != null && elapsed - lastThrottle.t < 4000)
	const p50 = median(rpc.latencies)
	const gap = rpcRate && solRate ? solRate / rpcRate : null
	const solSource = health?.source
	// The SSE flag can flicker on a reconnect; events still arriving count as streaming.
	const lastSol = sol.trace.at(-1)
	const streaming = connected || (lastSol != null && !done && elapsed - lastSol.t < 5000)

	let rpcFoot: ReactNode
	let rpcFootClass = 'text-ink-3'
	if (rpc.http429 > 0) {
		rpcFoot = `Throttled ${rpc.http429}× · ${Math.max(0, sol.n - rpc.delivered)} fewer than the stream in the same window`
		rpcFootClass = 'text-risk'
	} else if (!done) {
		rpcFoot =
			elapsed < 1500
				? 'Asking for signatures…'
				: `One request at a time · p50 ${ms(p50)} per round trip`
	} else if (gap) {
		rpcFoot = `No 429 this run, still ${gap.toFixed(1)}× slower than the stream (${rpcRate}/min vs ${solRate}/min)`
		rpcFootClass = 'text-ink-2'
	} else {
		rpcFoot = `No 429 this run · ${rpc.delivered} tx in 30 s`
	}

	const rpcChip = throttledNow ? (
		<ChipStatus tone="risk">THROTTLED · 429</ChipStatus>
	) : done ? (
		<ChipStatus tone="outline">DONE</ChipStatus>
	) : (
		<ChipStatus tone="outline">POLLING</ChipStatus>
	)

	return (
		<section className="mx-auto flex w-full max-w-[1520px] flex-col gap-7 px-4 pt-10 pb-14 sm:px-8">
			<div className="flex flex-wrap items-end justify-between gap-6">
				<div className="flex max-w-[940px] flex-col gap-3.5">
					<Kicker>Under the hood · same chain, same 30 seconds</Kicker>
					<h1 className="m-0 font-display text-[clamp(44px,5.2vw,80px)] leading-[0.92] font-bold text-balance">
						{headline}
					</h1>
				</div>
				<div className="flex items-center gap-[18px] font-mono">
					<div className="flex flex-col items-end gap-0.5">
						<span className="text-[9.5px] tracking-label text-ink-3">ELAPSED</span>
						<span className="text-[28px] font-medium tabular-nums" aria-live="off">
							T+{(elapsed / 1000).toFixed(1)}s
						</span>
					</div>
					<button
						type="button"
						onClick={() => setRunKey((k) => k + 1)}
						className="border border-ink px-4 py-2.5 text-data-s tracking-[0.1em] transition-colors hover:bg-ink hover:text-bg"
					>
						↻ REPLAY
					</button>
				</div>
			</div>

			<div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,520px),1fr))] gap-px border border-line-soft bg-line-soft">
				<Panel
					kicker="PUBLIC RPC · POLLING getTransaction"
					title="api.mainnet-beta.solana.com"
					chip={rpcChip}
					count={rpc.delivered}
					countClass={rpc.http429 > 0 ? 'text-risk' : 'text-ink'}
					unit="transactions delivered"
					hint={
						<>
							{rpcRate ?? '—'} / min effective · {rpc.http429} × HTTP 429
							{rpc.errors > 0 && ` · ${rpc.errors} errors`}
						</>
					}
					canvasRef={rpcCanvas}
					log={rpc.log.map((l) => (
						<LogRow
							key={l.id}
							t={l.t}
							text={l.text}
							code={l.code}
							className={RPC_COLOR[l.kind]}
							codeClass="font-semibold"
						/>
					))}
					foot={rpcFoot}
					footClass={rpcFootClass}
					note={
						rpc.via === 'relay'
							? 'This endpoint answers 403 to browser origins, so calls go through a no-cache relay on this site.'
							: null
					}
				/>
				<Panel
					kicker="SOLAMI · YELLOWSTONE gRPC · PUSH"
					title="Decoded DBC program events"
					chip={
						streaming ? (
							<ChipStatus tone="ink">STREAMING</ChipStatus>
						) : (
							<ChipStatus tone="sell">OFFLINE</ChipStatus>
						)
					}
					count={sol.n}
					unit="events delivered"
					hint={<>{solRate ?? '—'} / min · over SSE to this tab</>}
					canvasRef={solCanvas}
					log={
						sol.log.length === 0 ? (
							<span className="py-2 text-ink-3">
								{connected
									? 'Listening for the next DBC event…'
									: 'Stream offline: no events can arrive.'}
							</span>
						) : (
							sol.log.map((l) => (
								<LogRow
									key={l.id}
									t={l.t}
									text={l.text}
									code={l.code}
									className={SOL_COLOR[l.kind]}
									codeClass="text-ink-3"
								/>
							))
						)
					}
					foot={
						solSource && solSource !== 'grpc'
							? `Pushed as the indexer decodes them (source: ${solSource}). No polling from your browser.`
							: 'Pushed from the validator as each block lands. No polling, no rate limit.'
					}
					footClass="text-ink-2"
				/>
			</div>
		</section>
	)
}
