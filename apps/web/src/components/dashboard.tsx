'use client'

import Link from 'next/link'
import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiBase, type GlobalStats, type LiveEvent, type PoolSummary, type Tab } from '@/lib/api'
import { ago, duration, int, usd } from '@/lib/format'
import { useNow, useReducedMotion } from '@/lib/hooks'
import { DEFAULT_FILTERS, type Filters, passes } from './radar/filters'
import { LiveFeed, type PoolInfo } from './radar/live-feed'
import { applyEvent, createModel, type ScopeMode, scaleLabel, syncPools } from './radar/model'
import { type Flash, PoolTable } from './radar/pool-table'
import { Scope } from './radar/scope'
import { useStream } from './stream-provider'
import { Checkbox, Filter, OfflineBanner, Stat, type TabItem, Tabs } from './ui'

const TAB_META: Record<Tab, { label: string; short?: string; hint: string }> = {
	new: { label: 'New launches', short: 'New', hint: 'Pools created since the radar started' },
	progress: {
		label: 'Near graduation',
		short: 'Near grad',
		hint: 'Closest to the migration threshold',
	},
	hot: { label: 'Hot', hint: 'Highest USD volume in the last 5 minutes' },
	graduated: { label: 'Graduated', hint: 'Curves completed and migrating to DAMM' },
}
const TAB_IDS: Tab[] = ['new', 'progress', 'hot', 'graduated']
const ROWS = 20

type Snapshot<T> = { data: T | null; error: Error | null; startedAt: number }

/** Poll a JSON endpoint, remembering when each request started (to expire live overlays). */
const useSnapshot = <T,>(
	path: string,
	intervalMs: number,
	onData?: (data: T, startedAt: number) => void,
) => {
	const [snap, setSnap] = useState<Snapshot<T>>({ data: null, error: null, startedAt: 0 })
	const onDataRef = useRef(onData)
	onDataRef.current = onData
	const tickRef = useRef<() => void>(() => {})
	useEffect(() => {
		let active = true
		const tick = async () => {
			const startedAt = Date.now()
			try {
				const res = await fetch(`${apiBase}${path}`, { cache: 'no-store' })
				if (!res.ok) throw new Error(`${res.status} ${path}`)
				const data = (await res.json()) as T
				if (!active) return
				onDataRef.current?.(data, startedAt)
				setSnap({ data, error: null, startedAt })
			} catch (err) {
				if (active) setSnap((s) => ({ ...s, error: err as Error }))
			}
		}
		tickRef.current = () => void tick()
		tick()
		const timer = setInterval(tick, intervalMs)
		return () => {
			active = false
			clearInterval(timer)
		}
	}, [path, intervalMs])
	/** Fetch now (e.g. right after a launch), on top of the regular interval. */
	const refresh = useCallback(() => tickRef.current(), [])
	return { ...snap, refresh }
}

/** Live values from trades that landed after the last snapshot of a pool was requested. */
type Overlay = {
	start: number
	progress: number | null
	priceUsd: number | null
	buys: number
	sells: number
	vol: number
	lastTradeAt: number
}

const toFilterable = (p: PoolSummary) => ({
	vol5: p.volume5m,
	score: p.risk.score,
	quoteSymbol: p.quoteSymbol ?? null,
	launchpad: p.launchpad ?? null,
})

type LiveGrad = { pool: string; at: number }
type StatDelta = { l1: number; l24: number; g24: number; t1: number; v1: number }
const ZERO_DELTA: StatDelta = { l1: 0, l24: 0, g24: 0, t1: 0, v1: 0 }

export const Dashboard = () => {
	const { subscribe, connected, health, healthError } = useStream()
	const reduced = useReducedMotion()
	const now = useNow(1000)
	const [tab, setTab] = useState<Tab>('new')
	const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
	const [bump, setBump] = useState(0)
	const [liveGrad, setLiveGrad] = useState<LiveGrad | null>(null)

	const model = useRef(createModel()).current
	const overlay = useRef(new Map<string, Overlay>())
	const flashRef = useRef<Flash[]>([])
	const delta = useRef<StatDelta>({ ...ZERO_DELTA })
	const index = useRef(new Map<string, PoolSummary>())

	const expire = useCallback((list: PoolSummary[], startedAt: number) => {
		for (const p of list) {
			index.current.set(p.pool, p)
			const o = overlay.current.get(p.pool)
			if (o && o.start < startedAt) overlay.current.delete(p.pool)
		}
	}, [])
	const all = useSnapshot<PoolSummary[]>('/pools?sort=new&limit=200', 4000, expire)
	const near = useSnapshot<PoolSummary[]>('/pools?sort=progress&limit=50', 4000, expire)
	const hot = useSnapshot<PoolSummary[]>('/pools?sort=hot&limit=50', 4000, expire)
	const grads = useSnapshot<PoolSummary[]>('/graduated?limit=50', 5000, expire)
	const stats = useSnapshot<GlobalStats>('/stats', 5000, (_, startedAt) => {
		delta.current = { ...ZERO_DELTA }
		void startedAt
	})

	const [span, setSpan] = useState(model.span)
	// Launches/graduations refetch their lists right away so new rows (and blips) appear now.
	const refreshRef = useRef({ all: all.refresh, near: near.refresh, grads: grads.refresh })
	refreshRef.current = { all: all.refresh, near: near.refresh, grads: grads.refresh }
	const refreshSoon = useCallback((which: 'all' | 'near' | 'grads') => {
		setTimeout(() => refreshRef.current[which](), 600)
	}, [])

	// One raw subscription: canvas model, table overlay + flashes, stat deltas, re-sort triggers.
	useEffect(
		() =>
			subscribe((e: LiveEvent) => {
				const t = Date.now()
				applyEvent(model, e, t, performance.now())
				const d = delta.current
				if (e.type === 'trade') {
					const o = overlay.current.get(e.pool) ?? {
						start: t,
						progress: null,
						priceUsd: null,
						buys: 0,
						sells: 0,
						vol: 0,
						lastTradeAt: t,
					}
					if (e.progress != null) o.progress = e.progress
					if (e.price != null && e.usdAmount != null && e.quoteAmount > 0)
						o.priceUsd = (e.price * e.usdAmount) / e.quoteAmount
					if (e.side === 'buy') o.buys++
					else o.sells++
					o.vol += e.usdAmount ?? 0
					o.lastTradeAt = t
					overlay.current.set(e.pool, o)
					flashRef.current.push({ pool: e.pool, side: e.side, strong: false })
					if (flashRef.current.length > 500) flashRef.current.splice(0, 250)
					d.t1++
					d.v1 += e.usdAmount ?? 0
				} else if (e.type === 'pool_created') {
					d.l1++
					d.l24++
					refreshSoon('all')
					setBump((n) => n + 1)
				} else if (e.type === 'graduated') {
					d.g24++
					setLiveGrad({ pool: e.pool, at: t })
					refreshSoon('grads')
					refreshSoon('near')
					setBump((n) => n + 1)
				} else if (e.type === 'risk' && e.flag === 'creator_sold') {
					flashRef.current.push({ pool: e.pool, side: 'sell', strong: true })
				}
			}),
		[subscribe, model, refreshSoon],
	)

	const withLive = useCallback((p: PoolSummary): PoolSummary => {
		const o = overlay.current.get(p.pool)
		if (!o) return p
		return {
			...p,
			progress: o.progress ?? p.progress,
			priceUsd: o.priceUsd ?? p.priceUsd,
			buys: p.buys + o.buys,
			sells: p.sells + o.sells,
			volume5m: p.volume5m + o.vol,
			lastTradeAt: Math.max(p.lastTradeAt ?? 0, o.lastTradeAt),
		}
	}, [])

	// `now` changes every second, so overlays reach the table at 1 Hz; flashes are immediate.
	const lists = useMemo(() => {
		void now
		const live = (list: PoolSummary[] | null) => (list ?? []).map(withLive)
		const allL = live(all.data)
		const merged = new Map<string, PoolSummary>()
		for (const p of [...allL, ...live(near.data), ...live(hot.data)]) merged.set(p.pool, p)
		const mergedL = [...merged.values()]
		const gradL = live(grads.data)
		return {
			new: allL
				.filter((p) => p.createdAt != null)
				.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0)),
			progress: live(near.data).sort((a, b) => (b.progress ?? 0) - (a.progress ?? 0)),
			hot: live(hot.data)
				.filter((p) => p.volume5m > 0)
				.sort((a, b) => b.volume5m - a.volume5m),
			graduated: gradL.sort((a, b) => (b.graduatedAt ?? 0) - (a.graduatedAt ?? 0)),
			merged: mergedL,
		}
	}, [now, all.data, near.data, hot.data, grads.data, withLive])

	// The scope draws exactly this list; the table shows its first ROWS.
	const filtered = useMemo(
		() => lists[tab].filter((p) => passes(toFilterable(p), filters)),
		[lists, tab, filters],
	)
	const rows = filtered.slice(0, ROWS)
	model.accept = (b) =>
		passes({ vol5: b.vol5, score: b.score, quoteSymbol: null, launchpad: null }, filters)
	useEffect(() => {
		syncPools(model, filtered, tab as ScopeMode, Date.now(), performance.now())
		setSpan(model.span)
	}, [model, filtered, tab])
	const angleLegend = `${tab === 'graduated' ? 'time since graduation' : 'age'} (${scaleLabel(span)})`

	// Cross-highlight: blip hover marks the table row; row hover rings the blip.
	const onBlipHover = useCallback((pool: string | null) => {
		for (const el of document.querySelectorAll('[data-row][data-hl]')) el.removeAttribute('data-hl')
		if (pool)
			for (const el of document.querySelectorAll(`[data-row="${pool}"]`))
				el.setAttribute('data-hl', '')
	}, [])
	const onRowHover = useCallback(
		(pool: string | null) => {
			model.tableHover = pool
		},
		[model],
	)
	const onOrder = useCallback(
		(ids: string[]) => {
			model.tableOrder = ids
		},
		[model],
	)
	const loading =
		(tab === 'graduated' ? grads : tab === 'progress' ? near : tab === 'hot' ? hot : all).data ==
		null

	const counts: Record<Tab, string> = {
		new: all.data ? String(lists.new.length) : '',
		progress: near.data
			? `${lists.merged.filter((p) => (p.progress ?? 0) >= 0.8).length} ≥80%`
			: '',
		hot: hot.data ? String(lists.merged.filter((p) => p.volume5m > 0).length) : '',
		graduated: grads.data ? String(lists.graduated.length) : '',
	}
	const tabs: TabItem<Tab>[] = TAB_IDS.map((id) => ({
		id,
		label: TAB_META[id].label,
		shortLabel: TAB_META[id].short,
		hint: TAB_META[id].hint,
		count: counts[id],
	}))

	// Launchpad filter: the three most common launchpads in the current snapshot.
	const pads = useMemo(() => {
		const tally = new Map<string, number>()
		for (const p of [...(all.data ?? []), ...(grads.data ?? [])])
			if (p.launchpad) tally.set(p.launchpad, (tally.get(p.launchpad) ?? 0) + 1)
		return [...tally.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3)
			.map(([pad]) => pad)
	}, [all.data, grads.data])

	const lookup = useCallback(
		(pool: string): PoolInfo | undefined => {
			const p = index.current.get(pool)
			const b = model.blips.get(pool)
			if (!p && !b) return undefined
			return {
				symbol: p?.symbol ?? b?.symbol ?? null,
				launchpad: p?.launchpad ?? b?.launchpad ?? null,
				createdAt: p?.createdAt ?? b?.createdAt ?? null,
			}
		},
		[model],
	)

	const offline = healthError != null || (health != null && !connected)
	const st = stats.data
	const d = delta.current
	const stat = (base: number | undefined, add: number) => (base == null ? undefined : base + add)

	const resortKey = `${tab}|${filters.minVol}|${filters.quote}|${filters.pad}|${filters.hideRisk}|${bump}`
	const setF = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }))

	return (
		<div className="flex flex-col">
			{offline && (
				<OfflineBanner
					lastEventAgeMs={health?.lastEventAgeMs}
					reconnects={health?.sourceStats?.reconnects}
				/>
			)}
			<section className="mx-auto grid w-full max-w-[1520px] grid-cols-[repeat(auto-fit,minmax(min(100%,520px),1fr))] items-center gap-x-14 gap-y-10 px-0 pt-4 pb-0 sm:px-8 sm:pt-9 sm:pb-10">
				<div className="hidden min-w-0 sm:block">
					<Scope
						model={model}
						angleLegend={angleLegend}
						onHoverChange={onBlipHover}
						offline={offline}
						lastEventAgeMs={health?.lastEventAgeMs}
					/>
				</div>
				<div className="flex min-w-0 flex-col gap-3.5 sm:gap-[34px]">
					<div className="flex flex-col gap-1.5 px-4 sm:gap-4 sm:px-0">
						<span className="font-mono text-label tracking-[0.12em] text-signal sm:text-data-s sm:tracking-[0.14em]">
							<span className="sm:hidden">METEORA DBC · SOLANA MAINNET</span>
							<span className="hidden sm:inline">
								METEORA DYNAMIC BONDING CURVE · SOLANA MAINNET
							</span>
						</span>
						<h1 className="font-display text-[30px] leading-[0.95] font-bold tracking-[0.005em] text-balance sm:text-[clamp(40px,4.6vw,64px)]">
							Every Meteora DBC pool on Solana mainnet
						</h1>
						<p className="hidden max-w-[44ch] text-body-l text-pretty text-ink-2 sm:block">
							Curve progress, real flow and rug signals, streamed live from Solami Yellowstone gRPC.
						</p>
					</div>
					<div className="px-4 sm:hidden">
						<Scope
							model={model}
							angleLegend={angleLegend}
							offline={offline}
							lastEventAgeMs={health?.lastEventAgeMs}
							variant="strip"
						/>
					</div>
					<div className="grid grid-cols-3 px-4 sm:px-0">
						<Stat
							label="Launches 1h"
							value={int(stat(st?.launches_1h, d.l1))}
							className="max-sm:gap-0.5 max-sm:pt-2.5 max-sm:pb-2.5 max-sm:pr-0 [&_.label]:text-[8.5px] sm:[&_.label]:text-[10px]"
						/>
						<Stat
							label="Launches 24h"
							value={int(stat(st?.launches_24h, d.l24))}
							className="hidden sm:flex sm:[&_.label]:text-[10px]"
						/>
						<Stat
							label={
								<>
									<span className="sm:hidden">Grads 24h</span>
									<span className="hidden sm:inline">Graduations 24h</span>
								</>
							}
							tickKey={stat(st?.graduations_24h, d.g24)}
							value={int(stat(st?.graduations_24h, d.g24))}
							tone="signal"
							className="max-sm:gap-0.5 max-sm:pt-2.5 max-sm:pb-2.5 max-sm:pr-0 [&_.label]:text-[8.5px] sm:[&_.label]:text-[10px]"
						/>
						<Stat
							label="Volume 1h"
							value={usd(stat(st?.volume_1h, d.v1))}
							className="sm:border-t-0 max-sm:gap-0.5 max-sm:pt-2.5 max-sm:pb-2.5 max-sm:pr-0 [&_.label]:text-[8.5px] sm:[&_.label]:text-[10px]"
						/>
						<Stat
							label="Trades 1h"
							value={int(stat(st?.trades_1h, d.t1))}
							className="hidden sm:flex sm:border-t-0 sm:[&_.label]:text-[10px]"
						/>
						<Stat
							label="Unique traders 1h"
							value={int(st?.traders_1h)}
							className="hidden sm:flex sm:border-t-0 sm:[&_.label]:text-[10px]"
						/>
					</div>
					<LastGraduation
						grads={grads.data}
						liveGrad={liveGrad}
						lookup={index}
						now={now}
						reduced={reduced}
					/>
				</div>
			</section>

			<div className="mx-auto flex w-full max-w-[1520px] flex-wrap items-start gap-7 pb-10 sm:px-8">
				<section
					aria-label="Pools"
					className={`min-w-0 flex-[999_1_820px] border-line sm:border-t ${offline ? 'opacity-50 grayscale' : ''}`}
				>
					<div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-line-soft px-4 sm:border-0 sm:px-0">
						<Tabs
							label="Pool lists"
							idPrefix="pools"
							items={tabs}
							value={tab}
							onChange={setTab}
							className="flex-nowrap gap-x-5 overflow-hidden whitespace-nowrap sm:flex-wrap"
						/>
						<div className="hidden flex-wrap items-center gap-x-[18px] gap-y-2.5 pb-2.5 sm:flex">
							<Filter
								label="Min vol 5m"
								value={filters.minVol}
								onChange={(minVol) => setF({ minVol })}
								options={[
									{ value: '0', label: 'Any' },
									{ value: '100', label: '$100' },
									{ value: '1000', label: '$1k' },
								]}
							/>
							<Filter
								label="Quote"
								value={filters.quote}
								onChange={(quote) => setF({ quote })}
								options={[
									{ value: 'all', label: 'All' },
									{ value: 'SOL', label: 'SOL' },
									{ value: 'USDC', label: 'USDC' },
								]}
							/>
							<Filter
								label="Launchpad"
								value={filters.pad}
								onChange={(pad) => setF({ pad })}
								options={[
									{ value: 'all', label: 'All' },
									...pads.map((p) => ({ value: p, label: p })),
								]}
							/>
							<Checkbox checked={filters.hideRisk} onChange={(hideRisk) => setF({ hideRisk })}>
								Hide risk ≥ 40
							</Checkbox>
						</div>
					</div>
					<p className="hidden border-b border-line-soft pt-2.5 pb-3 font-mono text-data-s text-ink-3 sm:block">
						{TAB_META[tab].hint} · reorders every 2s
					</p>
					<div id="pools-panel" role="tabpanel" aria-labelledby={`pools-${tab}`}>
						<PoolTable
							rows={rows}
							tab={tab}
							resortKey={resortKey}
							flashRef={flashRef}
							now={now}
							reduced={reduced}
							loading={loading}
							onRowHover={onRowHover}
							onOrder={onOrder}
						/>
					</div>
				</section>
				<LiveFeed
					subscribe={subscribe}
					lookup={lookup}
					className="min-w-0 flex-[1_1_300px] scroll-mt-16 border-t border-line px-4 sm:px-0"
				/>
			</div>
		</div>
	)
}

const GRAD_PATH = 'M2 38 C 46 38, 82 28, 108 5'

/** "Last graduation" panel: flashes amber and redraws its curve when a pool graduates live. */
const LastGraduation = ({
	grads,
	liveGrad,
	lookup,
	now,
	reduced,
}: {
	grads: PoolSummary[] | null
	liveGrad: LiveGrad | null
	lookup: RefObject<Map<string, PoolSummary>>
	now: number
	reduced: boolean
}) => {
	const boxRef = useRef<HTMLAnchorElement>(null)
	const curveRef = useRef<SVGPathElement>(null)
	const latest = grads?.[0] ?? null
	// A live graduation wins until the snapshot catches up with it.
	const liveInfo =
		liveGrad && (!latest || (latest.graduatedAt ?? 0) < liveGrad.at - 5000)
			? lookup.current.get(liveGrad.pool)
			: undefined
	const g =
		liveGrad && liveInfo
			? {
					pool: liveGrad.pool,
					symbol: liveInfo.symbol,
					name: liveInfo.name,
					graduatedAt: liveGrad.at,
					ttg: liveInfo.createdAt ? liveGrad.at - liveInfo.createdAt : null,
				}
			: latest
				? {
						pool: latest.pool,
						symbol: latest.symbol,
						name: latest.name,
						graduatedAt: latest.graduatedAt,
						ttg: latest.timeToGraduateMs,
					}
				: null

	useEffect(() => {
		if (!liveGrad) return
		boxRef.current?.animate(
			[
				{
					backgroundColor: 'color-mix(in oklch, var(--color-signal) 28%, var(--color-bg-2))',
					borderColor: 'var(--color-signal)',
				},
				{ backgroundColor: 'var(--color-bg-2)', borderColor: 'var(--color-line)' },
			],
			{ duration: reduced ? 1200 : 1400, easing: 'ease-out' },
		)
		if (!reduced)
			curveRef.current?.animate([{ strokeDashoffset: 100 }, { strokeDashoffset: 0 }], {
				duration: 900,
				easing: 'cubic-bezier(.5,0,.2,1)',
			})
	}, [liveGrad, reduced])

	const fast = g?.ttg != null && g.ttg < 60_000
	const inner = (
		<>
			<svg
				width="112"
				height="40"
				viewBox="0 0 112 40"
				className="overflow-visible"
				aria-hidden="true"
			>
				<path d={GRAD_PATH} fill="none" strokeWidth="1.5" className="stroke-line" />
				<path
					ref={curveRef}
					d={GRAD_PATH}
					fill="none"
					pathLength={100}
					strokeDasharray="100 100"
					strokeWidth="2.2"
					strokeLinecap="round"
					className="stroke-signal"
				/>
				<circle cx="110" cy="3" r="3.2" className="fill-signal" />
			</svg>
			<div className="flex min-w-0 flex-col gap-1">
				<span className="font-mono text-[10px] tracking-[0.12em] text-signal">LAST GRADUATION</span>
				<div className="flex min-w-0 items-baseline gap-2.5">
					<span className="max-w-[60%] truncate font-display text-display-m font-bold">
						{g ? (g.symbol ?? `${g.pool.slice(0, 4)}…`) : '—'}
					</span>
					<span className="truncate text-[13px] text-ink-3">{g?.name}</span>
				</div>
			</div>
			<div className="num flex flex-col items-end gap-[3px] text-data">
				<span>
					curve filled in{' '}
					<span className={`font-semibold ${fast ? 'text-signal' : 'text-ink'}`}>
						{duration(g?.ttg)}
					</span>
				</span>
				<span className="text-ink-3">
					{g?.graduatedAt && now ? ago(now - g.graduatedAt) : '—'} ago → DAMM v2
				</span>
			</div>
		</>
	)
	const cls =
		'hidden grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-5 border border-line bg-bg-2 px-5 py-4 sm:grid'
	return g ? (
		<Link
			ref={boxRef}
			href={`/pool/${g.pool}`}
			prefetch={false}
			className={`${cls} transition-colors hover:border-ink-3`}
		>
			{inner}
		</Link>
	) : (
		<div className={cls}>{inner}</div>
	)
}
