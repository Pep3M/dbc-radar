'use client'

import Link from 'next/link'
import { type ReactNode, type RefObject, useCallback, useEffect, useRef, useState } from 'react'
import { api, type PoolDetail, type RiskFlag } from '@/lib/api'
import {
	ago,
	count,
	duration,
	EMPTY,
	price as fmtPrice,
	int,
	links,
	pct,
	shortAddress,
	usd,
} from '@/lib/format'
import { useChangeTick, useNow, useReducedMotion } from '@/lib/hooks'
import { CandleChart, type ChartMarker } from './candle-chart'
import { BondingCurve } from './pool/bonding-curve'
import { FlowMeter } from './pool/flow-meter'
import { Holders } from './pool/holders'
import { createLiveModel, flowBuckets, type LiveModel, qty } from './pool/model'
import { RiskBreakdown } from './pool/risk-breakdown'
import { TradesTable } from './pool/trades-table'
import { useStream } from './stream-provider'
import { Chip, isSafeUrl, NotFoundState, RiskBadge, TokenImage } from './ui'

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ')

const PAGE = 'mx-auto w-full max-w-[1520px] px-4 sm:px-8'

/* ───────────────────────────── Data ───────────────────────────── */

type LoadState = { data: PoolDetail | null; error: 'not_found' | 'offline' | null }

/**
 * Snapshot every 3 s, plus `refreshSoon()` for stream events of this pool, throttled to one
 * fetch per second (stats tick at most once a second).
 */
const usePool = (pool: string) => {
	const [state, setState] = useState<LoadState>({ data: null, error: null })
	const last = useRef(0)
	const pending = useRef<ReturnType<typeof setTimeout> | null>(null)

	const load = useCallback(async () => {
		last.current = Date.now()
		try {
			const data = await api.pool(pool)
			setState({ data, error: null })
		} catch (err) {
			const notFound = err instanceof Error && err.message.startsWith('404')
			setState((s) => ({
				data: notFound ? null : s.data,
				error: notFound ? 'not_found' : 'offline',
			}))
		}
	}, [pool])

	useEffect(() => {
		setState({ data: null, error: null })
		load()
		const timer = setInterval(() => {
			if (Date.now() - last.current >= 2500) load()
		}, 3000)
		return () => {
			clearInterval(timer)
			if (pending.current) clearTimeout(pending.current)
			pending.current = null
		}
	}, [load])

	const refreshSoon = useCallback(() => {
		if (pending.current) return
		const wait = Math.max(150, last.current + 1000 - Date.now())
		pending.current = setTimeout(() => {
			pending.current = null
			load()
		}, wait)
	}, [load])

	return { ...state, refreshSoon }
}

type Raised = { flag: RiskFlag; key: number; from: number; to: number }

/* ───────────────────────────── Page ───────────────────────────── */

export const PoolView = ({ pool }: { pool: string }) => {
	const now = useNow()
	const { data, error, refreshSoon } = usePool(pool)
	const { subscribe } = useStream()
	const live = useRef<LiveModel>(createLiveModel())
	const [raised, setRaised] = useState<Raised | null>(null)
	const [gradPulse, setGradPulse] = useState(0)
	const scoreRef = useRef(0)
	scoreRef.current = data?.risk.score ?? 0

	// A fresh snapshot supersedes the stream's progress; drop live ticks it now contains.
	useEffect(() => {
		if (!data) return
		const model = live.current
		model.progress = null
		// The snapshot covers every trade up to its newest row; keep only newer live ticks, plus
		// ones still growing in (the curve copies their animation onto the matching row).
		const newest = data.recentTrades.reduce((a, t) => Math.max(a, t.ts), 0)
		const nowPerf = performance.now()
		model.ticks = model.ticks.filter(
			(t) => nowPerf - t.t0 < 30_000 && (t.ts > newest || nowPerf - t.t0 < 1000),
		)
	}, [data])

	useEffect(
		() =>
			subscribe((event) => {
				if (event.type === 'alert' || event.pool !== pool) return
				const model = live.current
				if (event.type === 'trade') {
					model.ticks.push({
						side: event.side,
						usd: event.usdAmount ?? 0,
						progress: event.progress ?? model.progress ?? 0,
						trader: event.trader,
						ts: event.ts,
						t0: performance.now(),
					})
					if (event.progress != null) model.progress = event.progress
				} else if (event.type === 'graduated') {
					model.gradAt = performance.now()
					setGradPulse((k) => k + 1)
				} else if (event.type === 'risk') {
					if (event.flag === 'creator_sold') model.rugAt = performance.now()
					setRaised({ flag: event.flag, key: Date.now(), from: scoreRef.current, to: event.score })
				}
				refreshSoon()
			}),
		[pool, subscribe, refreshSoon],
	)

	useEffect(() => {
		if (data?.symbol) document.title = `${data.symbol} · DBC Radar`
	}, [data?.symbol])

	if (error === 'not_found') {
		return (
			<NotFoundState
				className={PAGE}
				path={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/pool/${shortAddress(pool)}`}
				solscanHref={links.solscanAccount(pool)}
			/>
		)
	}
	if (!data) {
		return (
			<PoolSkeleton
				label={
					error === 'offline' ? 'indexer unreachable · retrying…' : 'loading pool from indexer…'
				}
			/>
		)
	}
	return (
		<PoolBody
			data={data}
			now={now}
			live={live}
			raised={raised}
			gradPulse={gradPulse}
			stale={error === 'offline'}
		/>
	)
}

const PoolBody = ({
	data,
	now,
	live,
	raised,
	gradPulse,
	stale,
}: {
	data: PoolDetail
	now: number
	live: RefObject<LiveModel>
	raised: Raised | null
	gradPulse: number
	stale: boolean
}) => {
	const graduated = data.graduatedAt != null
	const progress = graduated ? 1 : (data.progress ?? null)
	const hot = graduated || (progress ?? 0) >= 0.8
	const symbol = data.symbol ?? shortAddress(data.baseMint ?? data.pool, 4)
	const quote = data.quoteSymbol ?? 'SOL'
	const flow5m = flowBuckets(data, '5m', now)
	const creatorAlarm = data.risk.flags.includes('creator_sold') || raised?.flag === 'creator_sold'
	const markers: ChartMarker[] = [
		...(data.graduatedAt ? [{ ts: data.graduatedAt, kind: 'graduated' as const }] : []),
		...data.recentTrades
			.filter((t) => t.side === 'sell' && data.creator && t.trader === data.creator)
			.map((t) => ({ ts: t.ts, kind: 'creator_sold' as const })),
	]
	const pctLabel = graduated ? '100%' : pct(progress)

	return (
		<div className={cx(PAGE, 'pb-6 sm:pb-12')}>
			{/* Mobile top bar: back + compact risk. */}
			<div className="-mx-4 flex h-[52px] items-center justify-between border-b border-line-soft px-4 font-mono text-data-s sm:hidden">
				<Link href="/" className="flex min-h-11 items-center text-ink-2">
					← Radar
				</Link>
				<RiskBadge score={data.risk.score} flags={data.risk.flags} />
			</div>
			<div className="hidden items-center gap-2 pt-[18px] font-mono text-data-s text-ink-3 sm:flex">
				<Link href="/" className="text-ink-2 hover:text-signal">
					← Radar
				</Link>
				<span>/</span>
				<bdi>{symbol}</bdi>
				{stale && (
					<span className="ml-auto text-sell">○ indexer unreachable · snapshot frozen</span>
				)}
			</div>

			{creatorAlarm && <CreatorAlarm data={data} raised={raised} />}
			{graduated && <GraduatedBanner data={data} now={now} pulse={gradPulse} />}

			{/* Header */}
			<section className="grid items-end gap-x-10 gap-y-6 pt-[18px] sm:grid-cols-[minmax(0,1fr)_auto] sm:pt-[26px] sm:pb-[30px]">
				<div className="flex min-w-0 items-center gap-3 sm:gap-5">
					<TokenImage
						src={data.image}
						label={symbol}
						seed={data.baseMint ?? data.pool}
						pending={!data.symbol}
						size={64}
						className="max-sm:!size-12 max-sm:!text-[14px]"
					/>
					<div className="flex min-w-0 flex-col gap-1 sm:gap-2">
						<div className="flex min-w-0 flex-wrap items-baseline gap-x-3.5 gap-y-1.5">
							<h1 className="max-w-full truncate font-display text-[40px] leading-[0.9] font-extrabold tracking-[0.02em] sm:text-[64px]">
								<bdi>{symbol}</bdi>
							</h1>
							{data.name && (
								<span className="hidden text-[18px] text-ink-2 sm:inline">
									<bdi>{data.name}</bdi>
								</span>
							)}
							{data.launchpad && (
								<span className="hidden sm:contents">
									<Chip>{data.launchpad}</Chip>
								</span>
							)}
							<span className="hidden sm:contents">
								<Chip>{quote}</Chip>
							</span>
						</div>
						<span className="text-[13px] text-ink-2 sm:hidden">
							{data.name && (
								<>
									<bdi>{data.name}</bdi> ·{' '}
								</>
							)}
							<span className="font-mono text-[10px] text-ink-3 uppercase">
								{[data.launchpad, quote].filter(Boolean).join(' · ')}
							</span>
						</span>
						<HeaderLinks data={data} className="hidden sm:flex" />
					</div>
				</div>
				<HeaderLinks data={data} className="sm:hidden" mobile />
				<div className="hidden items-end gap-7 sm:flex">
					<div className="flex flex-col items-end gap-2">
						<span className="font-mono text-[10px] tracking-[0.1em] text-ink-3">CURVE</span>
						<TickValue
							value={pctLabel}
							className={cx(
								'font-display text-[80px] leading-[0.92] font-extrabold tabular-nums',
								hot ? 'text-signal' : 'text-ink',
							)}
						/>
					</div>
					<span key={raised?.key ?? 0} className={raised ? 'animate-alarm' : undefined}>
						<RiskBadge
							score={data.risk.score}
							flags={data.risk.flags}
							size="header"
							className="px-3.5"
						/>
					</span>
				</div>
				{/* Mobile curve block */}
				<div className="flex items-end justify-between border-t border-line pt-3 sm:hidden">
					<div className="flex flex-col gap-1.5">
						<span
							className={cx(
								'font-mono text-label tracking-label',
								hot ? 'text-signal' : 'text-ink-3',
							)}
						>
							CURVE
						</span>
						<TickValue
							value={pctLabel}
							className={cx(
								'font-display text-[64px] leading-[0.9] font-extrabold tabular-nums',
								hot ? 'text-signal' : 'text-ink',
							)}
						/>
					</div>
					<span className="num pb-1 text-right text-data-s text-ink-2">
						{reserveLine(data, quote)}
						<br />
						<span className="text-ink-3">{remainingLine(data, quote)}</span>
					</span>
				</div>
			</section>

			<BondingCurve data={data} live={live} className="mt-3 sm:hidden" />

			<StatsGrid data={data} now={now} hot={hot} quote={quote} />

			{/* Panels: one flat flex-wrap so phones can reorder (risk → flow → price → trades → holders). */}
			<div className="flex flex-wrap gap-x-10 gap-y-[22px] pt-[22px] sm:gap-y-10 sm:pt-9">
				<section className="hidden min-w-0 flex-[999_1_720px] border-t border-line sm:order-1 sm:block">
					<header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 pt-4 pb-3">
						<h2 className="font-display text-section font-bold tracking-[0.03em] uppercase">
							Bonding curve
						</h2>
						<span className="num text-[10.5px] text-ink-3">{curveCaption(data, quote)}</span>
					</header>
					<BondingCurve data={data} live={live} />
				</section>
				<RiskBreakdown
					data={data}
					flow5m={flow5m}
					raised={raised}
					className="order-1 flex-[1_1_360px] sm:order-2"
				/>
				<section className="order-3 min-w-0 flex-[999_1_720px] border-t border-line">
					<header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 pt-3 pb-2 sm:pt-4 sm:pb-3">
						<h2 className="font-display text-[18px] font-bold tracking-[0.03em] uppercase sm:text-section">
							Price<span className="hidden sm:inline"> · {data.priceUsd ? 'USD' : quote}</span> · 1m
							<span className="hidden sm:inline"> candles</span>
						</h2>
						<div className="hidden gap-4 font-mono text-[10.5px] text-ink-3 sm:flex">
							<span className="flex items-center gap-1.5">
								<span className="h-3 w-2 bg-buy" />
								up · filled
							</span>
							<span className="flex items-center gap-1.5">
								<span className="h-3 w-2 border-[1.5px] border-sell" />
								down · hollow
							</span>
						</div>
					</header>
					{data.candles.length === 0 ? (
						<div className="hatch-ink flex h-[200px] items-center justify-center border border-line-soft font-mono text-[10.5px] text-ink-3 sm:h-[340px]">
							no candles yet
						</div>
					) : (
						<CandleChart
							candles={data.candles}
							usdPerQuote={data.price && data.priceUsd ? data.priceUsd / data.price : null}
							markers={markers}
						/>
					)}
				</section>
				<FlowMeter data={data} now={now} className="order-2 flex-[1_1_360px] sm:order-4" />
				<Holders data={data} className="order-5 flex-[1_1_380px] max-sm:order-6" />
				<TradesTable data={data} now={now} className="order-4 flex-[999_1_640px] sm:order-6" />
			</div>

			{data.baseMint && (
				<div className="sticky bottom-[calc(60px+env(safe-area-inset-bottom))] -mx-4 mt-4 bg-[linear-gradient(to_top,var(--color-bg)_70%,transparent)] px-4 pt-3 pb-3 sm:hidden">
					<a
						href={links.jupiter(data.baseMint)}
						target="_blank"
						rel="noopener noreferrer"
						className="flex h-[52px] items-center justify-center bg-ink font-mono text-data font-semibold tracking-[0.08em] text-bg"
					>
						TRADE ON JUPITER ↗
					</a>
				</div>
			)}
		</div>
	)
}

/* ───────────────────────────── Header bits ───────────────────────────── */

const HeaderLinks = ({
	data,
	className,
	mobile = false,
}: {
	data: PoolDetail
	className?: string
	mobile?: boolean
}) => {
	const item = (href: string, label: string | null, value: ReactNode) => (
		<a
			key={href}
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className="text-ink underline decoration-line underline-offset-[3px] hover:text-signal hover:decoration-signal"
		>
			{label && <span className="text-ink-3">{label} </span>}
			{value}
		</a>
	)
	const mint = data.baseMint
	return (
		<div
			className={cx(
				'num gap-x-[18px] gap-y-1 text-data-s sm:text-[11.5px]',
				mobile ? 'flex overflow-x-auto whitespace-nowrap' : 'flex-wrap',
				className,
			)}
		>
			{mint && item(links.solscanToken(mint), 'mint', shortAddress(mint))}
			{item(links.solscanAccount(data.pool), 'pool', shortAddress(data.pool))}
			{data.creator &&
				item(links.solscanAccount(data.creator), 'creator', shortAddress(data.creator))}
			{!mobile && mint && item(links.jupiter(mint), null, 'trade on Jupiter ↗')}
			{isSafeUrl(data.twitter) && item(data.twitter, null, 'X ↗')}
			{isSafeUrl(data.website) && item(data.website, null, 'website ↗')}
		</div>
	)
}

/** Value that rolls in (380 ms) whenever its text changes; never on first render. */
const TickValue = ({ value, className }: { value: string; className?: string }) => {
	const { tick } = useChangeTick(value)
	return (
		<span className="block overflow-hidden">
			<span key={tick} className={cx('block', tick > 0 && 'animate-tick', className)}>
				{value}
			</span>
		</span>
	)
}

const reserveLine = (data: PoolDetail, quote: string) =>
	data.migrationThreshold
		? `${qty(data.graduatedAt ? data.migrationThreshold : (data.quoteReserve ?? 0))} / ${qty(data.migrationThreshold)} ${quote}`
		: EMPTY

const remainingLine = (data: PoolDetail, quote: string) => {
	if (data.graduatedAt) return `filled in ${duration(ttg(data))}`
	if (!data.migrationThreshold || data.quoteReserve == null) return 'threshold unknown'
	return `${qty(Math.max(0, data.migrationThreshold - data.quoteReserve))} ${quote} to graduate`
}

const curveCaption = (data: PoolDetail, quote: string) => {
	if (data.graduatedAt) {
		return `curve complete · ${data.migrationThreshold != null ? qty(data.migrationThreshold) : EMPTY} ${quote} reached in ${duration(ttg(data))}`
	}
	return `${reserveLine(data, quote)} · ${remainingLine(data, quote)}`
}

const ttg = (data: PoolDetail) =>
	data.timeToGraduateMs ??
	(data.graduatedAt && data.createdAt ? data.graduatedAt - data.createdAt : null)

/* ───────────────────────────── Banners ───────────────────────────── */

const CreatorAlarm = ({ data, raised }: { data: PoolDetail; raised: Raised | null }) => {
	const ref = useRef<HTMLDivElement>(null)
	const reduced = useReducedMotion()
	const liveAlarm = raised?.flag === 'creator_sold' ? raised : null
	useEffect(() => {
		if (!liveAlarm || reduced || !ref.current) return
		ref.current.animate(
			[
				{ opacity: 0 },
				{ opacity: 1 },
				{ opacity: 0.3 },
				{ opacity: 1 },
				{ opacity: 0.3 },
				{ opacity: 1 },
			],
			{ duration: 900, easing: 'steps(6, end)' },
		)
	}, [liveAlarm, reduced])
	return (
		<div
			ref={ref}
			role="alert"
			className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 bg-risk px-[18px] py-3 font-mono text-data text-risk-ink"
		>
			<span className="font-display text-[22px] leading-none font-extrabold tracking-[0.06em]">
				◆ CREATOR SOLD
			</span>
			<span>
				{data.creatorSold > 0 ? `${usd(data.creatorSold)} · ` : ''}
				{shortAddress(data.creator)} sold into the curve
			</span>
			<span className="ml-auto font-semibold">
				{liveAlarm ? `risk ${liveAlarm.from} → ${liveAlarm.to}` : `risk ${data.risk.score}`}
			</span>
		</div>
	)
}

const GraduatedBanner = ({
	data,
	now,
	pulse,
}: {
	data: PoolDetail
	now: number
	pulse: number
}) => {
	const ref = useRef<HTMLDivElement>(null)
	const reduced = useReducedMotion()
	useEffect(() => {
		if (!pulse || !ref.current) return
		ref.current.animate(
			reduced
				? [{ opacity: 0.6 }, { opacity: 1 }]
				: [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }],
			{ duration: 700, easing: 'cubic-bezier(.5,0,.2,1)' },
		)
	}, [pulse, reduced])
	const linkClass =
		'justify-self-start border-[1.5px] border-signal-ink px-3 py-[7px] font-mono text-data font-semibold text-signal-ink no-underline hover:bg-signal-ink hover:text-signal sm:justify-self-end'
	return (
		<div
			ref={ref}
			className="mt-4 grid items-center gap-x-7 gap-y-3 bg-signal px-[22px] py-4 text-signal-ink sm:grid-cols-[auto_minmax(0,1fr)_auto]"
		>
			<span className="font-display text-[34px] leading-none font-extrabold tracking-[0.04em]">
				◉ GRADUATED
			</span>
			<div className="num flex flex-wrap gap-x-6 gap-y-1 text-[12.5px]">
				<span>
					curve filled in <span className="font-semibold">{duration(ttg(data))}</span>
				</span>
				<span>{now && data.graduatedAt ? `${ago(now - data.graduatedAt)} ago` : EMPTY}</span>
				<span>
					last curve price <span className="font-semibold">{fmtPrice(data.priceUsd)}</span>
				</span>
			</div>
			{data.dammPool ? (
				<a
					href={links.solscanAccount(data.dammPool)}
					target="_blank"
					rel="noopener noreferrer"
					className={linkClass}
				>
					DAMM v2 pool {shortAddress(data.dammPool)} ↗
				</a>
			) : data.baseMint ? (
				<a
					href={links.jupiter(data.baseMint)}
					target="_blank"
					rel="noopener noreferrer"
					className={linkClass}
				>
					migrated to DAMM v2 · trade on Jupiter ↗
				</a>
			) : null}
		</div>
	)
}

/* ───────────────────────────── Stats ───────────────────────────── */

const StatsGrid = ({
	data,
	now,
	hot,
	quote,
}: {
	data: PoolDetail
	now: number
	hot: boolean
	quote: string
}) => {
	const graduated = data.graduatedAt != null
	const created = data.createdAt ?? data.firstSeenAt
	return (
		<section className="mt-4 grid grid-cols-2 border-t border-line sm:mt-0 sm:grid-cols-[repeat(auto-fit,minmax(176px,1fr))]">
			<PriceStat value={data.priceUsd} hint={graduated ? 'last on curve' : 'on curve'} />
			<PoolStat
				className="max-sm:hidden"
				label="Curve"
				value={graduated ? '100%' : pct(data.progress)}
				hint={`${reserveLine(data, quote)} quote`}
				tone={hot ? 'signal' : 'default'}
			/>
			<PoolStat label="Market cap" value={usd(data.mcapUsd)} hint="via Solami Blur" />
			<PoolStat label="Liquidity" value={usd(data.liquidityUsd)} hint="via Solami Blur" />
			<PoolStat
				className="max-sm:hidden"
				label="Volume"
				value={usd(data.volume)}
				hint={`${int(data.trades)} trades`}
			/>
			<PoolStat label="Vol 5m" value={usd(data.volume5m)} hint="last 5 minutes" />
			<PoolStat
				label="Buys / Sells"
				value={`▲${count(data.buys)} ▼${count(data.sells)}`}
				display={
					<>
						<span aria-hidden="true">▲</span>
						{count(data.buys)} <span aria-hidden="true">▼</span>
						{count(data.sells)}
					</>
				}
				hint="count"
			/>
			<PoolStat label="Holders" value={int(data.holders)} hint="via Solami Data API" />
			<PoolStat
				label="Top buyer"
				value={data.buyVolume ? pct(data.topBuyerShare, 0) : EMPTY}
				hint="share of buy volume"
				tone={data.topBuyerShare > 0.4 ? 'risk' : 'default'}
			/>
			{graduated ? (
				<PoolStat
					label="Graduated"
					value={now && data.graduatedAt ? `${ago(now - data.graduatedAt)} ago` : EMPTY}
					hint={`in ${duration(ttg(data))}`}
					tone="signal"
					tick={false}
				/>
			) : (
				<PoolStat
					label="Age"
					value={now ? duration(now - created) : EMPTY}
					hint="since pool creation"
					tick={false}
				/>
			)}
		</section>
	)
}

const cell =
	'flex min-w-0 flex-col gap-0.5 border-b border-line-soft py-2.5 sm:gap-[5px] sm:pt-3.5 sm:pr-3.5 sm:pb-4'
const labelClass =
	'font-mono text-[8.5px] tracking-[0.08em] uppercase sm:text-label sm:tracking-label'
const valueClass =
	'block truncate font-display text-[26px] leading-none font-bold whitespace-nowrap tabular-nums sm:text-[clamp(28px,2.6vw,36px)]'

const PoolStat = ({
	label,
	value,
	display,
	hint,
	tone = 'default',
	tick = true,
	className,
}: {
	label: string
	value: string
	display?: ReactNode
	hint?: ReactNode
	tone?: 'default' | 'signal' | 'risk'
	/** Roll the digits on change (off for clocks). */
	tick?: boolean
	className?: string
}) => {
	const { tick: n } = useChangeTick(value)
	return (
		<div className={cx(cell, className)}>
			<span className={cx(labelClass, tone === 'signal' ? 'text-signal' : 'text-ink-3')}>
				{label}
			</span>
			<span className="block overflow-hidden">
				<span
					key={tick ? n : 0}
					title={value}
					className={cx(
						valueClass,
						tick && n > 0 && 'animate-tick',
						tone === 'signal' && 'text-signal',
						tone === 'risk' && 'text-risk',
					)}
					style={tone === 'signal' ? { ['--tick-color' as string]: 'var(--color-ink)' } : undefined}
				>
					{display ?? value}
				</span>
			</span>
			{hint && <span className="hidden font-mono text-[10px] text-ink-3 sm:block">{hint}</span>}
		</div>
	)
}

/** Price nudges up in blue on a rise, down in orange on a fall (700 ms). */
const PriceStat = ({ value, hint }: { value: number | null; hint: string }) => {
	const { tick, direction } = useChangeTick(value)
	return (
		<div className={cell}>
			<span className={cx(labelClass, 'text-ink-3')}>Price</span>
			<span className="block overflow-hidden">
				<span
					key={tick}
					className={cx(
						valueClass,
						tick > 0 && direction > 0 && 'animate-price-up',
						tick > 0 && direction < 0 && 'animate-price-down',
					)}
				>
					{fmtPrice(value)}
				</span>
			</span>
			<span className="hidden font-mono text-[10px] text-ink-3 sm:block">{hint}</span>
		</div>
	)
}

/* ───────────────────────────── Loading ───────────────────────────── */

/** First snapshot: static skeleton (motion always means data, so nothing shimmers). */
export const PoolSkeleton = ({ label = 'loading pool from indexer…' }: { label?: string }) => (
	<div className={cx(PAGE, 'pb-12')} role="status" aria-live="polite">
		<div className="flex items-center justify-between pt-[18px] font-mono text-data-s text-ink-3">
			<Link href="/" className="text-ink-2">
				← Radar
			</Link>
			<span>{label}</span>
		</div>
		<div aria-hidden="true">
			<div className="flex items-center gap-5 pt-[26px] pb-[30px]">
				<span className="size-12 shrink-0 rounded-full bg-bg-3 sm:size-16" />
				<div className="flex flex-1 flex-col gap-3">
					<span className="h-10 w-48 bg-bg-3 sm:h-14 sm:w-72" />
					<span className="h-2.5 w-64 max-w-full bg-bg-3" />
				</div>
				<span className="hidden h-20 w-[92px] border-[1.5px] border-line sm:block" />
			</div>
			<div className="grid grid-cols-2 border-t border-line sm:grid-cols-[repeat(auto-fit,minmax(176px,1fr))]">
				{Array.from({ length: 7 }, (_, i) => (
					<div
						// biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
						key={i}
						className="flex flex-col gap-2 border-b border-line-soft py-4 pr-3.5"
						style={{ opacity: Math.max(0.3, 1 - i * 0.1) }}
					>
						<span className="h-2 w-12 bg-bg-3" />
						<span className="h-7 w-24 bg-bg-3" />
					</div>
				))}
			</div>
			<div className="mt-9 border-t border-line pt-4">
				<span className="block h-4 w-40 bg-bg-3" />
				<svg
					viewBox="0 0 720 300"
					className="mt-6 h-[150px] w-full sm:h-[380px]"
					preserveAspectRatio="none"
				>
					<path
						d="M10 290 C 300 290, 520 230, 710 12"
						fill="none"
						strokeWidth="1.5"
						strokeDasharray="3 5"
						vectorEffect="non-scaling-stroke"
						className="stroke-line"
					/>
				</svg>
			</div>
		</div>
	</div>
)
