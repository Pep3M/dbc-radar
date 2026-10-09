'use client'

import Link from 'next/link'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { LiveEvent, RiskFlag } from '@/lib/api'
import { age, duration, progressPct, shortAddress, usd } from '@/lib/format'
import { FLUSH_MS, type LiveListener, useNow } from '@/lib/hooks'
import { FLAG_LABEL, FLAG_WEIGHT } from '../ui'

/** What the feed knows about a pool beyond the event itself (from the REST snapshot / model). */
export type PoolInfo = {
	symbol: string | null
	launchpad: string | null
	createdAt: number | null
}

type Item =
	| {
			kind: 'trade'
			side: 'buy' | 'sell'
			pool: string
			symbol: string
			usd: number
			progress: number | null
			t: number
	  }
	| { kind: 'new'; pool: string; mint: string; creator: string; pad: string | null; t: number }
	| { kind: 'grad'; pool: string; symbol: string; ttg: number | null; t: number }
	| { kind: 'risk'; pool: string; symbol: string; flag: RiskFlag; t: number }
	| { kind: 'micro'; n: number; usd: number; t: number }

type Row = Item & { id: number }

const MAX_TRADES = 4
const MICRO_USD = 2
const MICRO_MS = 2500
const CAP = 44

/**
 * Live feed with the handoff's batching: flush every 250 ms, at most 4 trades per flush
 * (largest first); trades under $2 and the overflow collapse into one "+N small trades · $x"
 * line every 2.5 s. Launches, graduations and risk flags always get their own line.
 */
export const LiveFeed = ({
	subscribe,
	lookup,
	className,
}: {
	subscribe: (listener: LiveListener) => () => void
	lookup: (pool: string) => PoolInfo | undefined
	className?: string
}) => {
	const [rows, setRows] = useState<Row[]>([])
	const now = useNow(1000)
	const lookupRef = useRef(lookup)
	lookupRef.current = lookup

	useEffect(() => {
		const pending: Item[] = []
		let micro = { n: 0, usd: 0 }
		let microAt = 0
		let nextId = 0
		const label = (pool: string, symbol?: string | null) =>
			symbol ?? lookupRef.current(pool)?.symbol ?? shortAddress(pool)
		const onEvent = (e: LiveEvent) => {
			const t = Date.now()
			if (e.type === 'trade') {
				const value = e.usdAmount ?? 0
				if (value < MICRO_USD) {
					micro.n++
					micro.usd += value
					return
				}
				pending.push({
					kind: 'trade',
					side: e.side,
					pool: e.pool,
					symbol: label(e.pool, e.symbol),
					usd: value,
					progress: e.progress,
					t,
				})
			} else if (e.type === 'pool_created') {
				pending.push({
					kind: 'new',
					pool: e.pool,
					mint: e.baseMint,
					creator: e.creator,
					pad: lookupRef.current(e.pool)?.launchpad ?? null,
					t,
				})
			} else if (e.type === 'graduated') {
				const info = lookupRef.current(e.pool)
				pending.push({
					kind: 'grad',
					pool: e.pool,
					symbol: label(e.pool),
					ttg: info?.createdAt ? e.ts - info.createdAt : null,
					t,
				})
			} else if (e.type === 'risk') {
				pending.push({
					kind: 'risk',
					pool: e.pool,
					symbol: label(e.pool, e.symbol),
					flag: e.flag,
					t,
				})
			}
		}
		const unsubscribe = subscribe(onEvent)
		const timer = setInterval(() => {
			const t = Date.now()
			const items = pending.splice(0)
			const trades = items
				.filter((i) => i.kind === 'trade')
				.sort((a, b) => (b.kind === 'trade' ? b.usd : 0) - (a.kind === 'trade' ? a.usd : 0))
			for (const overflow of trades.slice(MAX_TRADES)) {
				micro.n++
				if (overflow.kind === 'trade') micro.usd += overflow.usd
			}
			const batch: Item[] = [
				...items.filter((i) => i.kind !== 'trade'),
				...trades.slice(0, MAX_TRADES),
			].sort((a, b) => a.t - b.t)
			if (micro.n && t - microAt > MICRO_MS) {
				batch.unshift({ kind: 'micro', n: micro.n, usd: micro.usd, t })
				micro = { n: 0, usd: 0 }
				microAt = t
			}
			if (!batch.length) return
			const added = batch.map((item) => ({ ...item, id: nextId++ })).reverse()
			setRows((prev) => [...added, ...prev].slice(0, CAP))
		}, FLUSH_MS)
		return () => {
			unsubscribe()
			clearInterval(timer)
		}
	}, [subscribe])

	return (
		<aside id="feed" className={className} aria-label="Live feed">
			<div className="flex items-baseline justify-between gap-3 border-b border-line-soft pt-4 pb-3">
				<h2 className="font-display text-section font-bold tracking-[0.03em] whitespace-nowrap uppercase">
					Live feed
				</h2>
				<span className="truncate font-mono text-[10px] text-ink-3">
					batched 250ms · micro trades grouped
				</span>
			</div>
			<div
				className="flex h-[640px] flex-col overflow-hidden sm:h-[1060px]"
				style={{
					maskImage: 'linear-gradient(to bottom, black 82%, transparent)',
					WebkitMaskImage: 'linear-gradient(to bottom, black 82%, transparent)',
				}}
				aria-live="off"
			>
				{rows.length === 0 && (
					<p className="px-1 py-6 font-mono text-data text-ink-3">Listening for DBC events…</p>
				)}
				{rows.map((row) => (
					<FeedRow key={row.id} row={row} now={now} />
				))}
			</div>
		</aside>
	)
}

const ROW =
	'grid flex-none animate-feed-enter grid-cols-[14px_40px_minmax(0,1fr)_auto] items-center gap-2 border-b border-line-soft px-1 py-[7px] font-mono text-[11.5px] tabular-nums'

const Tag = ({ children, className }: { children: ReactNode; className: string }) => (
	<span className={`py-px text-center text-label font-semibold tracking-[0.06em] ${className}`}>
		{children}
	</span>
)

const FeedRow = ({ row, now }: { row: Row; now: number }) => {
	const when = <span className="text-[10.5px] text-ink-3">{age(row.t, now)}</span>
	if (row.kind === 'micro') {
		return (
			<div className={ROW}>
				<span className="text-center text-ink-3">·</span>
				<span />
				<span className="truncate text-ink-3">
					+{row.n} small trades · {usd(row.usd)}
				</span>
				{when}
			</div>
		)
	}
	let glyph: ReactNode
	let tag: ReactNode
	let main: ReactNode
	let tone = 'text-ink'
	if (row.kind === 'trade') {
		const buy = row.side === 'buy'
		glyph = <span className={buy ? 'text-buy' : 'text-sell'}>{buy ? '▲' : '▼'}</span>
		tag = <Tag className={buy ? 'text-buy' : 'text-sell'}>{buy ? 'BUY' : 'SELL'}</Tag>
		main = (
			<>
				{usd(row.usd)} · <bdi>{row.symbol}</bdi>{' '}
				<span className="text-ink-3">{row.progress != null && progressPct(row.progress)}</span>
			</>
		)
	} else if (row.kind === 'new') {
		glyph = <span className="text-ink">+</span>
		tag = <Tag className="bg-bg-3 text-ink">NEW</Tag>
		main = (
			<>
				{shortAddress(row.mint)} by {shortAddress(row.creator)}{' '}
				{row.pad && <span className="text-ink-3">{row.pad}</span>}
			</>
		)
	} else if (row.kind === 'grad') {
		glyph = <span className="text-signal">◉</span>
		tag = <Tag className="bg-signal text-signal-ink">GRAD</Tag>
		tone = 'text-signal'
		main = (
			<>
				<bdi>{row.symbol}</bdi> completed its curve{' '}
				{row.ttg != null && <span className="text-ink-3">in {duration(row.ttg)}</span>}
			</>
		)
	} else {
		glyph = <span className="text-risk">◆</span>
		tag = <Tag className="bg-risk text-risk-ink">RISK</Tag>
		tone = 'text-risk'
		main = (
			<>
				<bdi>{row.symbol}</bdi> {FLAG_LABEL[row.flag]}{' '}
				<span className="text-ink-3">+{FLAG_WEIGHT[row.flag]}</span>
			</>
		)
	}
	return (
		<Link
			href={`/pool/${row.pool}`}
			prefetch={false}
			className={`${ROW} transition-colors hover:bg-bg-2`}
		>
			<span className="text-center">{glyph}</span>
			{tag}
			<span className={`truncate ${tone}`}>{main}</span>
			{when}
		</Link>
	)
}
