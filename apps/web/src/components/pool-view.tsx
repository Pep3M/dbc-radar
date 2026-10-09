'use client'

import Link from 'next/link'
import { api } from '@/lib/api'
import { age, links, pct, price, shortAddress, usd } from '@/lib/format'
import { useNow, usePolling } from '@/lib/hooks'
import { CandleChart } from './candle-chart'
import { ExternalLink, ProgressBar, RiskBadge, RiskFlags, Stat, TokenImage } from './ui'

export const PoolView = ({ pool }: { pool: string }) => {
	const now = useNow()
	const { data, error } = usePolling(() => api.pool(pool), 3000, [pool])

	if (error && !data) {
		return <p className="p-6 text-sm text-red-300">Pool not found or indexer unreachable.</p>
	}
	if (!data) return <p className="p-6 text-sm text-white/45">Loading…</p>

	const usdPerQuote = data.price && data.priceUsd ? data.priceUsd / data.price : 1
	const mint = data.baseMint

	return (
		<div className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-6">
			<Link href="/" className="text-sm text-white/50 hover:text-white">
				← Radar
			</Link>
			<header className="mt-3 flex flex-wrap items-center justify-between gap-4">
				<div className="flex items-center gap-4">
					<TokenImage src={data.image} label={data.symbol ?? '??'} size={52} />
					<div>
						<h1 className="text-2xl font-semibold">
							{data.symbol ?? shortAddress(mint ?? data.pool, 6)}
							{data.name && <span className="ml-2 text-base text-white/45">{data.name}</span>}
						</h1>
						<div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-white/50">
							{mint && (
								<ExternalLink href={links.solscanToken(mint)}>
									mint {shortAddress(mint)}
								</ExternalLink>
							)}
							<ExternalLink href={links.solscanAccount(data.pool)}>
								pool {shortAddress(data.pool)}
							</ExternalLink>
							{data.creator && (
								<ExternalLink href={links.solscanAccount(data.creator)}>
									creator {shortAddress(data.creator)}
								</ExternalLink>
							)}
							{mint && <ExternalLink href={links.jupiter(mint)}>trade on Jupiter</ExternalLink>}
							{data.twitter && <ExternalLink href={data.twitter}>X</ExternalLink>}
							{data.website && <ExternalLink href={data.website}>website</ExternalLink>}
						</div>
					</div>
				</div>
				<div className="flex items-center gap-4">
					<ProgressBar value={data.progress} graduated={data.graduatedAt !== null} />
					<RiskBadge score={data.risk.score} flags={data.risk.flags} />
				</div>
			</header>

			<section className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-5 lg:grid-cols-10">
				<Stat label="Price" value={price(data.priceUsd)} />
				<Stat
					label="Curve"
					value={pct(data.progress)}
					hint={
						data.migrationThreshold
							? `${data.quoteReserve?.toFixed(2)} / ${data.migrationThreshold.toFixed(2)} quote`
							: undefined
					}
				/>
				<Stat label="Market cap" value={usd(data.mcapUsd)} hint="via Solami Blur" />
				<Stat label="Liquidity" value={usd(data.liquidityUsd)} />
				<Stat label="Volume" value={usd(data.volume)} />
				<Stat label="Vol 5m" value={usd(data.volume5m)} />
				<Stat label="Buys / Sells" value={`${data.buys} / ${data.sells}`} />
				<Stat label="Holders" value={data.holders ?? '—'} hint="via Solami Data API" />
				<Stat label="Top buyer" value={pct(data.topBuyerShare, 0)} hint="share of buy volume" />
				<Stat
					label={data.graduatedAt ? 'Graduated' : 'Age'}
					value={age(data.graduatedAt ?? data.createdAt ?? data.firstSeenAt, now)}
				/>
			</section>

			<div className="mt-6 grid gap-6 lg:grid-cols-[1fr_380px]">
				<section className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
					<h2 className="mb-2 px-1 text-sm font-medium">Price (USD, 1m candles)</h2>
					<CandleChart candles={data.candles} usdPerQuote={usdPerQuote} />
				</section>
				<section className="rounded-lg border border-white/10 bg-white/[0.02] p-4">
					<h2 className="text-sm font-medium">Risk signals</h2>
					<div className="mt-3">
						<RiskFlags flags={data.risk.flags} />
					</div>
					<dl className="mt-4 space-y-2 text-xs text-white/60">
						<div className="flex justify-between">
							<dt>Creator sold</dt>
							<dd className="font-mono">{usd(data.creatorSold)}</dd>
						</div>
						<div className="flex justify-between">
							<dt>Buy vs sell volume</dt>
							<dd className="font-mono">
								{usd(data.buyVolume)} / {usd(data.sellVolume)}
							</dd>
						</div>
						<div className="flex justify-between">
							<dt>Top 10 holders (excl. curve)</dt>
							<dd className="font-mono">{pct(data.top10Pct)}</dd>
						</div>
						<div className="flex justify-between">
							<dt>Held by bot-tagged wallets</dt>
							<dd className="font-mono">{pct(data.botPct)}</dd>
						</div>
						<div className="flex justify-between">
							<dt>Fresh wallets in top 20</dt>
							<dd className="font-mono">{data.freshHolders ?? '—'}</dd>
						</div>
						<div className="flex justify-between">
							<dt>Unique traders</dt>
							<dd className="font-mono">{data.uniqueTraders}</dd>
						</div>
						<div className="flex justify-between">
							<dt>Traders per trade</dt>
							<dd className="font-mono">
								{data.trades ? (data.uniqueTraders / data.trades).toFixed(2) : '—'}
							</dd>
						</div>
					</dl>
				</section>
			</div>

			<section className="mt-6 rounded-lg border border-white/10 bg-white/[0.02]">
				<h2 className="border-b border-white/10 px-4 py-2.5 text-sm font-medium">Recent trades</h2>
				<div className="overflow-x-auto">
					<table className="w-full text-xs">
						<thead className="text-left uppercase tracking-wider text-white/40">
							<tr>
								<th className="px-4 py-2 font-normal">Side</th>
								<th className="px-4 py-2 font-normal">Trader</th>
								<th className="px-4 py-2 text-right font-normal">USD</th>
								<th className="px-4 py-2 text-right font-normal">Price</th>
								<th className="px-4 py-2 text-right font-normal">Age</th>
								<th className="px-4 py-2 text-right font-normal">Tx</th>
							</tr>
						</thead>
						<tbody className="font-mono">
							{data.recentTrades.map((t) => (
								<tr key={t.signature} className="border-t border-white/5">
									<td
										className={`px-4 py-1.5 ${t.side === 'buy' ? 'text-emerald-300' : 'text-red-300'}`}
									>
										{t.side}
										{t.trader === data.creator && (
											<span className="ml-1 text-amber-300">(creator)</span>
										)}
									</td>
									<td className="px-4 py-1.5">
										<ExternalLink href={links.solscanAccount(t.trader)}>
											{shortAddress(t.trader)}
										</ExternalLink>
									</td>
									<td className="px-4 py-1.5 text-right">{usd(t.usd_amount)}</td>
									<td className="px-4 py-1.5 text-right">
										{price(t.price == null ? null : t.price * usdPerQuote)}
									</td>
									<td className="px-4 py-1.5 text-right text-white/50">{age(t.ts, now)}</td>
									<td className="px-4 py-1.5 text-right">
										<ExternalLink href={links.solscanTx(t.signature)}>
											{shortAddress(t.signature)}
										</ExternalLink>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>
		</div>
	)
}
