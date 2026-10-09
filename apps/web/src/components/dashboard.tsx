'use client'

import Link from 'next/link'
import { useState } from 'react'
import { api, type PoolSummary, type Tab } from '@/lib/api'
import { age, duration, pct, price, shortAddress, usd } from '@/lib/format'
import { type FeedItem, useLiveStream, useNow, usePolling } from '@/lib/hooks'
import { ProgressBar, RiskBadge, Stat, TokenImage } from './ui'

const TABS: { id: Tab; label: string; hint: string }[] = [
	{ id: 'new', label: 'New launches', hint: 'Pools created since the radar started' },
	{ id: 'progress', label: 'Near graduation', hint: 'Closest to the migration threshold' },
	{ id: 'hot', label: 'Hot', hint: 'Highest USD volume in the last 5 minutes' },
	{ id: 'graduated', label: 'Graduated', hint: 'Curves completed and migrating to DAMM' },
]

const tokenLabel = (pool: { symbol: string | null; baseMint: string | null; pool: string }) =>
	pool.symbol ?? shortAddress(pool.baseMint ?? pool.pool)

export const Dashboard = () => {
	const [tab, setTab] = useState<Tab>('new')
	const now = useNow()
	const { items, connected, eventsPerMinute } = useLiveStream()
	const { data: pools, error } = usePolling(() => api.pools(tab), 4000, [tab])
	const { data: stats } = usePolling(api.stats, 5000)
	const { data: health } = usePolling(api.health, 5000)

	const freshPools = new Set(items.filter((i) => now - i.ts < 2500).map((i) => i.pool))

	return (
		<div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6">
			<header className="flex flex-wrap items-end justify-between gap-4">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight">
						DBC Radar <span className="text-white/40">/ Meteora launches, live</span>
					</h1>
					<p className="mt-1 text-sm text-white/50">
						Every Dynamic Bonding Curve pool on Solana mainnet: curve progress, real flow and rug
						signals, streamed from Solami Yellowstone gRPC.
					</p>
				</div>
				<StreamStatus
					connected={connected}
					source={health?.source}
					eventsPerMinute={eventsPerMinute}
					lastEventAgeMs={health?.lastEventAgeMs ?? null}
					reconnects={health?.sourceStats?.reconnects}
				/>
			</header>

			<section className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
				<Stat label="Launches 1h" value={stats?.launches_1h ?? '—'} />
				<Stat label="Launches 24h" value={stats?.launches_24h ?? '—'} />
				<Stat label="Graduations 24h" value={stats?.graduations_24h ?? '—'} />
				<Stat label="Volume 1h" value={usd(stats?.volume_1h)} />
				<Stat label="Trades 1h" value={stats?.trades_1h ?? '—'} />
				<Stat label="Unique traders 1h" value={stats?.traders_1h ?? '—'} />
			</section>

			<div className="mt-6 grid gap-6 lg:grid-cols-[1fr_340px]">
				<section className="min-w-0 rounded-lg border border-white/10 bg-white/[0.02]">
					<nav className="flex gap-1 overflow-x-auto border-b border-white/10 p-2">
						{TABS.map((t) => (
							<button
								type="button"
								key={t.id}
								title={t.hint}
								onClick={() => setTab(t.id)}
								className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition ${
									tab === t.id ? 'bg-white/10 text-white' : 'text-white/55 hover:text-white'
								}`}
							>
								{t.label}
							</button>
						))}
					</nav>
					{error && (
						<p className="p-4 text-sm text-red-300">Indexer unreachable: {error.message}</p>
					)}
					<PoolTable pools={pools ?? []} now={now} freshPools={freshPools} tab={tab} />
				</section>
				<LiveFeed items={items} now={now} />
			</div>

			<footer className="mt-10 border-t border-white/10 pt-4 text-xs text-white/40">
				Built for Colosseum Crypto World&apos;s Fair · data via{' '}
				<a
					className="underline"
					href="https://solami.dev"
					target="_blank"
					rel="noopener noreferrer"
				>
					Solami
				</a>{' '}
				· by{' '}
				<a className="underline" href="https://pep3marquez.com">
					pep3marquez
				</a>
				. Not financial advice: risk flags are heuristics over on-chain flow.
			</footer>
		</div>
	)
}

const StreamStatus = (props: {
	connected: boolean
	source?: string
	eventsPerMinute: number
	lastEventAgeMs: number | null
	reconnects?: number
}) => (
	<div className="flex items-center gap-3 rounded-lg border border-white/10 px-3 py-2 font-mono text-xs">
		<span className="flex items-center gap-1.5">
			<span
				className={`size-2 rounded-full ${props.connected ? 'animate-pulse bg-emerald-400' : 'bg-red-500'}`}
			/>
			{props.connected ? 'live' : 'offline'}
		</span>
		<span className="text-white/50">src: {props.source ?? '—'}</span>
		<span className="text-white/50">{props.eventsPerMinute} ev/min</span>
		<span className="text-white/50">
			last {props.lastEventAgeMs == null ? '—' : `${(props.lastEventAgeMs / 1000).toFixed(1)}s`}
		</span>
		{props.reconnects !== undefined && (
			<span className="text-white/50">reconnects {props.reconnects}</span>
		)}
	</div>
)

const PoolTable = ({
	pools,
	now,
	freshPools,
	tab,
}: {
	pools: PoolSummary[]
	now: number
	freshPools: Set<string>
	tab: Tab
}) => {
	if (pools.length === 0) {
		return <p className="p-6 text-sm text-white/45">Waiting for pools…</p>
	}
	return (
		<div className="overflow-x-auto">
			<table className="w-full text-sm">
				<thead className="text-left text-[11px] uppercase tracking-wider text-white/40">
					<tr>
						<th className="px-3 py-2 font-normal">Token</th>
						<th className="px-3 py-2 font-normal">{tab === 'graduated' ? 'Graduated' : 'Age'}</th>
						<th className="px-3 py-2 font-normal">Price</th>
						<th className="px-3 py-2 font-normal">Curve</th>
						<th className="px-3 py-2 text-right font-normal">Vol 5m</th>
						<th className="px-3 py-2 text-right font-normal">MCap</th>
						<th className="px-3 py-2 text-right font-normal">Buys / Sells</th>
						<th className="px-3 py-2 text-right font-normal">Holders</th>
						<th
							className="px-3 py-2 text-right font-normal"
							title="Top 10 holders' share of circulating supply (curve vault excluded)"
						>
							Top 10
						</th>
						<th className="px-3 py-2 text-right font-normal">Risk</th>
					</tr>
				</thead>
				<tbody>
					{pools.map((p) => (
						<tr
							key={`${p.pool}-${p.lastTradeAt}`}
							className={`border-t border-white/5 hover:bg-white/[0.04] ${freshPools.has(p.pool) ? 'animate-flash' : ''}`}
						>
							<td className="px-3 py-2">
								<Link
									href={`/pool/${p.pool}`}
									className="flex items-center gap-2.5 hover:text-sky-300"
								>
									<TokenImage src={p.image} label={tokenLabel(p)} />
									<span className="min-w-0">
										<span className="block font-medium">{tokenLabel(p)}</span>
										{p.name && (
											<span className="block max-w-36 truncate text-xs text-white/40">
												{p.name}
											</span>
										)}
									</span>
								</Link>
							</td>
							<td className="px-3 py-2 font-mono text-xs text-white/60">
								{age(tab === 'graduated' ? p.graduatedAt : (p.createdAt ?? p.firstSeenAt), now)}
								{tab === 'graduated' && p.timeToGraduateMs !== null && (
									<span
										className={`block ${p.timeToGraduateMs < 60_000 ? 'text-amber-300' : 'text-white/40'}`}
										title="Time from pool creation to curve completion"
									>
										in {duration(p.timeToGraduateMs)}
									</span>
								)}
							</td>
							<td className="px-3 py-2 font-mono text-xs">{price(p.priceUsd)}</td>
							<td className="px-3 py-2">
								<ProgressBar value={p.progress} graduated={p.graduatedAt !== null} />
							</td>
							<td className="px-3 py-2 text-right font-mono text-xs">{usd(p.volume5m)}</td>
							<td className="px-3 py-2 text-right font-mono text-xs">{usd(p.mcapUsd)}</td>
							<td className="px-3 py-2 text-right font-mono text-xs">
								<span className="text-emerald-300">{p.buys}</span>
								<span className="text-white/30"> / </span>
								<span className="text-red-300">{p.sells}</span>
							</td>
							<td className="px-3 py-2 text-right font-mono text-xs">{p.holders ?? '—'}</td>
							<td className="px-3 py-2 text-right font-mono text-xs">{pct(p.top10Pct, 0)}</td>
							<td className="px-3 py-2 text-right">
								<RiskBadge score={p.risk.score} flags={p.risk.flags} />
							</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	)
}

const LiveFeed = ({ items, now }: { items: FeedItem[]; now: number }) => (
	<aside className="rounded-lg border border-white/10 bg-white/[0.02]">
		<h2 className="border-b border-white/10 px-4 py-2.5 text-sm font-medium">Live feed</h2>
		<ul className="max-h-[640px] overflow-y-auto">
			{items.length === 0 && <li className="p-4 text-sm text-white/45">Listening…</li>}
			{items.map((item) => (
				<li key={item.id} className="animate-flash border-b border-white/5 px-4 py-2 text-xs">
					<Link href={`/pool/${item.pool}`} className="flex items-center justify-between gap-2">
						<FeedLabel item={item} />
						<span className="font-mono text-white/35">{age(item.ts, now)}</span>
					</Link>
				</li>
			))}
		</ul>
	</aside>
)

const FeedLabel = ({ item }: { item: FeedItem }) => {
	switch (item.type) {
		case 'pool_created':
			return (
				<span>
					<span className="mr-1.5 rounded bg-sky-500/15 px-1 text-sky-300">NEW</span>
					{shortAddress(item.baseMint)} by {shortAddress(item.creator)}
				</span>
			)
		case 'graduated':
			return (
				<span>
					<span className="mr-1.5 rounded bg-violet-500/15 px-1 text-violet-300">GRAD</span>
					{shortAddress(item.pool)} completed its curve
				</span>
			)
		case 'trade':
			return (
				<span>
					<span className={item.side === 'buy' ? 'text-emerald-300' : 'text-red-300'}>
						{item.side === 'buy' ? 'BUY' : 'SELL'}
					</span>{' '}
					{usd(item.usdAmount)} · {shortAddress(item.pool)}{' '}
					{item.progress !== null && <span className="text-white/40">{pct(item.progress, 0)}</span>}
				</span>
			)
	}
}
