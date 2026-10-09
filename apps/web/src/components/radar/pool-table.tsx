'use client'

import Link from 'next/link'
import {
	type MouseEvent,
	type RefObject,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from 'react'
import type { PoolSummary, Tab } from '@/lib/api'
import { age, ago, count, duration, int, pct, price, shortAddress, usd } from '@/lib/format'
import { FLUSH_MS } from '@/lib/hooks'
import {
	BuySell,
	CurveProgress,
	EmptyRow,
	LoadingRows,
	RiskBadge,
	RiskCell,
	TokenImage,
} from '../ui'

export type Flash = { pool: string; side: 'buy' | 'sell'; strong: boolean }

const COLS =
	'grid grid-cols-[minmax(220px,2fr)_64px_104px_136px_84px_84px_96px_64px_60px_140px] items-center gap-x-3 px-3'
const RESORT_MS = 2000
const EASE = 'cubic-bezier(.2,.8,.2,1)'

const label = (p: PoolSummary) => p.symbol ?? shortAddress(p.baseMint ?? p.pool)

/**
 * Pool table. Row order is frozen between re-sorts (every 2 s, or immediately when
 * `resortKey` changes: launch, graduation, tab or filter), and rows glide to their new slot
 * with FLIP. Trade flashes are applied straight to the DOM at 4 Hz, one per row per flush.
 * Under 640px every row folds into a two-line card (States and Mobile spec).
 */
export const PoolTable = ({
	rows,
	tab,
	resortKey,
	flashRef,
	now,
	reduced,
	loading,
	onRowHover,
	onOrder,
}: {
	rows: PoolSummary[]
	tab: Tab
	resortKey: string
	flashRef: RefObject<Flash[]>
	now: number
	reduced: boolean
	loading: boolean
	/** Pointer entered/left a row (cross-highlights the blip). */
	onRowHover?: (pool: string | null) => void
	/** Displayed order changed (scope labels prefer the top rows). */
	onOrder?: (ids: string[]) => void
}) => {
	const rootRef = useRef<HTMLDivElement>(null)
	const rowsRef = useRef(rows)
	rowsRef.current = rows
	const [order, setOrder] = useState<string[]>([])

	// Immediate re-sort on launch/graduation/tab/filter; periodic otherwise.
	// biome-ignore lint/correctness/useExhaustiveDependencies: resortKey is the trigger
	useEffect(() => {
		setOrder(rowsRef.current.map((r) => r.pool))
	}, [resortKey])
	useEffect(() => {
		const timer = setInterval(() => setOrder(rowsRef.current.map((r) => r.pool)), RESORT_MS)
		return () => clearInterval(timer)
	}, [])
	// First snapshot lands: don't wait for the timer.
	if (order.length === 0 && rows.length > 0) setOrder(rows.map((r) => r.pool))

	const byId = new Map(rows.map((r) => [r.pool, r]))
	const shown = order.map((id) => byId.get(id)).filter((r): r is PoolSummary => r != null)
	const shownKey = shown.map((r) => r.pool).join(',')
	useEffect(() => {
		onOrder?.(shownKey ? shownKey.split(',') : [])
	}, [shownKey, onOrder])
	const hover = onRowHover
		? {
				onMouseEnter: (e: MouseEvent<HTMLElement>) =>
					onRowHover(e.currentTarget.dataset.row ?? null),
				onMouseLeave: () => onRowHover(null),
			}
		: {}

	// FLIP: rows that moved glide from their old slot; new rows slide in from the left.
	const tops = useRef<Map<string, number> | null>(null)
	const lastTab = useRef(tab)
	useLayoutEffect(() => {
		const root = rootRef.current
		if (!root) return
		const next = new Map<string, number>()
		const tabChanged = lastTab.current !== tab
		lastTab.current = tab
		root.querySelectorAll<HTMLElement>('[data-row]').forEach((el, i) => {
			if (!el.offsetParent) return
			const id = el.dataset.row ?? ''
			const top = el.offsetTop
			next.set(id, top)
			if (reduced || !tops.current) return
			const old = tops.current.get(id)
			if (tabChanged) {
				el.animate(
					[
						{ opacity: 0, transform: 'translateY(6px)' },
						{ opacity: 1, transform: 'none' },
					],
					{ duration: 260, delay: i * 18, easing: EASE, fill: 'backwards' },
				)
			} else if (old != null && Math.abs(old - top) > 1) {
				el.animate([{ transform: `translateY(${old - top}px)` }, { transform: 'none' }], {
					duration: 420,
					easing: EASE,
				})
			} else if (old == null) {
				el.animate(
					[
						{
							opacity: 0,
							transform: 'translateX(-18px)',
							backgroundColor: 'color-mix(in oklch, var(--color-ink) 10%, transparent)',
						},
						{ opacity: 1, transform: 'none', backgroundColor: 'transparent' },
					],
					{ duration: 520, easing: EASE },
				)
			}
		})
		tops.current = next
	})

	// Trade flashes: 12 % side tint 900 ms + price nudge; creator sold = stepped hatch.
	useEffect(() => {
		const timer = setInterval(() => {
			const queue = flashRef.current
			if (!queue.length) return
			const batch = queue.splice(0)
			const root = rootRef.current
			if (!root) return
			const seen = new Set<string>()
			for (let i = batch.length - 1; i >= 0; i--) {
				const f = batch[i]
				if (seen.has(f.pool)) continue
				seen.add(f.pool)
				const color = f.strong
					? 'var(--color-risk)'
					: f.side === 'buy'
						? 'var(--color-buy)'
						: 'var(--color-sell)'
				for (const el of root.querySelectorAll<HTMLElement>(`[data-row="${f.pool}"]`)) {
					if (!el.offsetParent) continue
					if (f.strong) {
						el.animate(
							[
								{
									backgroundImage:
										'repeating-linear-gradient(135deg, color-mix(in oklch, var(--color-risk) 32%, transparent) 0 6px, transparent 6px 12px)',
								},
								{
									backgroundImage:
										'repeating-linear-gradient(135deg, color-mix(in oklch, var(--color-risk) 0%, transparent) 0 6px, transparent 6px 12px)',
								},
							],
							{ duration: 1600, easing: 'steps(8, end)' },
						)
					} else if (!reduced) {
						el.animate(
							[
								{ backgroundColor: `color-mix(in oklch, ${color} 12%, transparent)` },
								{ backgroundColor: 'transparent' },
							],
							{ duration: 900, easing: 'ease-out' },
						)
					}
					const priceEl = el.querySelector<HTMLElement>('[data-price]')
					priceEl?.animate(
						[
							{
								color,
								transform: reduced ? 'none' : `translateY(${f.side === 'buy' ? 5 : -5}px)`,
							},
							{ color: 'var(--color-ink)', transform: 'none' },
						],
						{ duration: reduced ? 1000 : 700, easing: EASE },
					)
				}
			}
		}, FLUSH_MS)
		return () => clearInterval(timer)
	}, [flashRef, reduced])

	const graduated = tab === 'graduated'
	const empty = !loading && shown.length === 0

	return (
		<div ref={rootRef}>
			{/* ≥ 640px: full table */}
			<div className="hidden overflow-x-auto sm:block">
				<div className="relative min-w-[1040px]">
					<div
						className={`${COLS} h-[34px] border-b border-line-soft font-mono text-label tracking-label text-ink-3 uppercase`}
					>
						<span>Token</span>
						<span>{graduated ? 'Graduated' : 'Age'}</span>
						<span>Price</span>
						<span>Curve</span>
						<span className="text-right">Vol 5m</span>
						<span className="text-right">MCap</span>
						<span className="text-right">Buys / Sells</span>
						<span className="text-right">Holders</span>
						<span
							className="text-right"
							title="Top 10 holders' share of circulating supply (curve vault excluded)"
						>
							Top 10
						</span>
						<span className="text-right">Risk</span>
					</div>
					{loading && <LoadingRows rows={4} label={null} />}
					{empty && <EmptyRow>Listening… no pools match these filters yet.</EmptyRow>}
					{shown.map((p) => (
						<DesktopRow key={p.pool} p={p} now={now} graduated={graduated} hover={hover} />
					))}
				</div>
			</div>
			{/* < 640px: two-line cards */}
			<div className="sm:hidden">
				{loading && <LoadingRows rows={4} label={null} />}
				{empty && <EmptyRow>Listening… no pools match these filters yet.</EmptyRow>}
				{shown.map((p) => (
					<MobileRow key={p.pool} p={p} now={now} graduated={graduated} />
				))}
			</div>
		</div>
	)
}

const ageCells = (p: PoolSummary, now: number, graduated: boolean) => {
	if (graduated && p.graduatedAt) {
		const ttg = p.timeToGraduateMs
		const fast = ttg != null && ttg < 60_000
		return {
			main: now ? `${ago(now - p.graduatedAt)} ago` : '—',
			sub: ttg != null ? `in ${duration(ttg)}${fast ? ' ⚑' : ''}` : '',
			fast,
		}
	}
	return { main: age(p.createdAt ?? p.firstSeenAt, now), sub: '', fast: false }
}

type RowHover = {
	onMouseEnter?: (e: MouseEvent<HTMLElement>) => void
	onMouseLeave?: () => void
}

const DesktopRow = ({
	p,
	now,
	graduated,
	hover,
}: {
	p: PoolSummary
	now: number
	graduated: boolean
	hover: RowHover
}) => {
	const a = ageCells(p, now, graduated)
	const sym = label(p)
	return (
		<Link
			href={`/pool/${p.pool}`}
			prefetch={false}
			data-row={p.pool}
			{...hover}
			className={`${COLS} num h-[54px] border-b border-line-soft text-data transition-colors hover:bg-bg-2 data-hl:bg-bg-3`}
		>
			<div className="flex min-w-0 items-center gap-2.5">
				<TokenImage src={p.image} label={sym} seed={p.baseMint ?? p.pool} pending={!p.symbol} />
				<div className="flex min-w-0 flex-col gap-0.5">
					<div className="flex min-w-0 items-center gap-1.5">
						<span
							title={p.symbol ?? undefined}
							className="max-w-[130px] truncate font-sans text-body font-semibold"
						>
							<bdi>{sym}</bdi>
						</span>
						{p.launchpad && (
							<span className="shrink-0 border border-line px-1 py-px text-[9px] leading-[1.3] tracking-[0.06em] text-ink-3 uppercase">
								{p.launchpad}
							</span>
						)}
					</div>
					<span title={p.name ?? undefined} className="truncate font-sans text-body-s text-ink-3">
						{[p.name ?? (p.symbol ? null : 'metadata pending'), p.quoteSymbol]
							.filter(Boolean)
							.join(' · ')}
					</span>
				</div>
			</div>
			<div className="flex flex-col gap-0.5 text-ink-2">
				<span>{a.main}</span>
				{a.sub && (
					<span className={`text-[10.5px] ${a.fast ? 'text-signal' : 'text-ink-3'}`}>{a.sub}</span>
				)}
			</div>
			<span data-price="1" className="block">
				{price(p.priceUsd)}
			</span>
			<CurveProgress value={p.progress} graduated={!!p.graduatedAt} />
			<span className="text-right">{usd(p.volume5m)}</span>
			<span className="text-right text-ink-2">{usd(p.mcapUsd)}</span>
			<BuySell buys={int(p.buys)} sells={int(p.sells)} className="justify-end" />
			<span className="text-right text-ink-2">{count(p.holders)}</span>
			<span className="text-right text-ink-2">{pct(p.top10Pct, 0)}</span>
			<RiskCell score={p.risk.score} flags={p.risk.flags} />
		</Link>
	)
}

const MobileRow = ({ p, now, graduated }: { p: PoolSummary; now: number; graduated: boolean }) => {
	const a = ageCells(p, now, graduated)
	const sym = label(p)
	const creatorSold = p.risk.flags.includes('creator_sold')
	return (
		<Link
			href={`/pool/${p.pool}`}
			prefetch={false}
			data-row={p.pool}
			className={`grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1 border-b border-line-soft px-4 py-2.5 ${creatorSold ? 'hatch-risk-soft' : ''}`}
		>
			<TokenImage
				src={p.image}
				label={sym}
				seed={p.baseMint ?? p.pool}
				size={32}
				pending={!p.symbol}
				className="row-span-2"
			/>
			<div className="flex min-w-0 items-center gap-1.5">
				<span className="truncate text-body font-semibold">{sym}</span>
				{creatorSold ? (
					<span className="shrink-0 font-mono text-[8.5px] font-semibold text-risk">CRTR SOLD</span>
				) : (
					p.launchpad && (
						<span className="shrink-0 border border-line px-[3px] py-px font-mono text-[8.5px] text-ink-3 uppercase">
							{p.launchpad}
						</span>
					)
				)}
			</div>
			<CurveProgress value={p.progress} graduated={!!p.graduatedAt} width={40} />
			<span className="num truncate text-[10.5px] text-ink-3">
				<span className={a.fast ? 'text-signal' : undefined}>{a.sub || a.main}</span> ·{' '}
				{usd(p.volume5m)} · <BuySell buys={int(p.buys)} sells={int(p.sells)} className="gap-1" />
			</span>
			<RiskBadge
				score={p.risk.score}
				flags={p.risk.flags}
				className="min-w-0! justify-self-end py-px! text-[10.5px]!"
			/>
		</Link>
	)
}
