'use client'

import { useEffect, useRef, useState } from 'react'
import type { PoolDetail, RiskFlag } from '@/lib/api'
import { int, pct, usd } from '@/lib/format'
import { useChangeTick, useReducedMotion } from '@/lib/hooks'
import { FLAG_WEIGHT, RISK_HIGH, RiskMeter } from '../ui'
import type { FlowBucket } from './model'

const ORDER: RiskFlag[] = [
	'creator_sold',
	'whale_buyer',
	'concentrated',
	'wash_trading',
	'dumping',
	'fresh_wallets',
]

const NAME: Record<RiskFlag, string> = {
	creator_sold: 'Creator sold',
	whale_buyer: 'Whale buyer',
	concentrated: 'Concentrated',
	wash_trading: 'Wash trading',
	dumping: 'Dumping',
	fresh_wallets: 'Fresh wallets',
}

const RULE: Record<RiskFlag, string> = {
	creator_sold: 'any sell by creator',
	whale_buyer: 'top buyer > 40% of buys',
	concentrated: 'top 10 > 50%, ≥ 20 holders',
	wash_trading: 'few wallets, many trades',
	dumping: '5m sells > 1.5× buys',
	fresh_wallets: '≥ 5 fresh in top 20',
}

/** Evidence line per flag, from fields the indexer already sends (never invented). */
const evidence = (data: PoolDetail, flow5m: FlowBucket[]): Record<RiskFlag, string> => {
	const b5 = flow5m.reduce((a, b) => a + b.buyUsd, 0)
	const s5 = flow5m.reduce((a, b) => a + b.sellUsd, 0)
	return {
		creator_sold:
			data.creatorSold > 0
				? `Sold ${usd(data.creatorSold)} into the curve`
				: data.creator
					? 'Creator wallet has not sold'
					: 'Creator not identified yet',
		whale_buyer: data.buyVolume
			? `Top buyer ${pct(data.topBuyerShare, 0)} of buy volume`
			: 'No buys yet',
		concentrated:
			data.top10Pct == null
				? 'Waiting for holders from Solami Data API'
				: `Top 10 hold ${pct(data.top10Pct)} · ${int(data.holders)} holders`,
		wash_trading: data.trades
			? `${(data.uniqueTraders / data.trades).toFixed(2)} traders per trade · ${data.trades} trades`
			: 'No trades yet',
		dumping: `5m sells ${usd(s5)} vs buys ${usd(b5)}`,
		fresh_wallets:
			data.freshHolders == null
				? 'Waiting for holders from Solami Data API'
				: `${data.freshHolders} fresh wallets in top 20`,
	}
}

/**
 * Risk breakdown: score / 100, hatched meter (one segment per raised flag), all six flags
 * with rule, evidence and weight, then the raw flow metrics. `raised` is the flag the stream
 * just raised: its row gets the stepped hatch and the meter blinks.
 */
export const RiskBreakdown = ({
	data,
	flow5m,
	raised,
	className,
}: {
	data: PoolDetail
	flow5m: FlowBucket[]
	raised: { flag: RiskFlag; key: number } | null
	className?: string
}) => {
	const [showAll, setShowAll] = useState(false)
	const reduced = useReducedMotion()
	const flags = ORDER.filter((f) => data.risk.flags.includes(f))
	const ev = evidence(data, flow5m)
	const high = data.risk.score >= RISK_HIGH
	const inactive = ORDER.filter((f) => !flags.includes(f))
	const rowsRef = useRef<HTMLDivElement>(null)
	const { tick } = useChangeTick(data.risk.score)

	useEffect(() => {
		if (!raised) return
		const row = rowsRef.current?.querySelector<HTMLElement>(`[data-flag="${raised.flag}"]`)
		if (!row) return
		const hatch =
			'repeating-linear-gradient(135deg, color-mix(in oklch, var(--color-risk) 30%, transparent) 0 6px, transparent 6px 12px)'
		row.animate([{ backgroundImage: hatch }, { backgroundImage: 'none' }], {
			duration: reduced ? 2000 : 1800,
			easing: reduced ? 'linear' : 'steps(8, end)',
		})
	}, [raised, reduced])

	return (
		<section className={`min-w-0 border-t border-line ${className ?? ''}`}>
			<header className="flex items-baseline justify-between gap-3 pt-3 pb-2 sm:pt-4 sm:pb-3">
				<h2 className="font-display text-[18px] font-bold tracking-[0.03em] uppercase sm:text-section">
					Risk breakdown
				</h2>
				<span className="num text-data-s sm:text-data">
					<span
						key={tick}
						className={`inline-block font-semibold ${tick ? 'animate-tick' : ''} ${high ? 'text-risk' : 'text-ink'}`}
					>
						{data.risk.score}
					</span>
					<span className="text-ink-3"> / 100</span>
				</span>
			</header>
			<RiskMeter
				key={raised?.key ?? 0}
				flags={flags}
				raised={raised != null}
				className="max-sm:h-2.5"
			/>
			<div className="relative hidden h-[22px] font-mono text-[9px] text-ink-3 sm:block">
				<span className="absolute top-1 left-0">0</span>
				<span className="absolute top-1 left-[40%] -translate-x-1/2">40 high</span>
				<span className="absolute top-1 right-0">100</span>
			</div>
			<div ref={rowsRef} className="flex flex-col">
				{ORDER.map((f) => {
					const on = flags.includes(f)
					return (
						<div
							key={f}
							data-flag={f}
							className={`grid grid-cols-[14px_minmax(0,1fr)_auto] items-baseline gap-x-2 gap-y-1 border-b border-line-soft py-2.5 sm:grid-cols-[16px_minmax(0,1fr)_auto] sm:gap-x-2.5 ${on || showAll ? '' : 'max-sm:hidden'}`}
						>
							<span
								className={`text-[11px] sm:text-data ${on ? 'text-risk' : 'text-ink-3'}`}
								aria-hidden="true"
							>
								{on ? '◆' : '○'}
							</span>
							<div className="flex min-w-0 flex-col gap-0.5">
								<span
									className={`text-[13px] font-semibold sm:text-[13.5px] ${on ? 'text-ink' : 'text-ink-3'}`}
								>
									{NAME[f]}{' '}
									<span className="hidden font-mono text-[10px] font-normal text-ink-3 sm:inline">
										{RULE[f]}
									</span>
								</span>
								<span
									className={`font-mono text-[10.5px] sm:text-data-s ${on ? 'text-risk' : 'text-ink-3'}`}
								>
									{ev[f]}
								</span>
							</div>
							<span
								className={`px-1.5 py-px font-mono text-data-s font-semibold sm:text-data ${on ? 'bg-risk text-risk-ink' : 'text-ink-3'}`}
							>
								+{FLAG_WEIGHT[f]}
								<span className="sr-only">{on ? ' raised' : ' not raised'}</span>
							</span>
						</div>
					)
				})}
			</div>
			{!showAll && inactive.length > 0 && (
				<p className="py-2.5 font-mono text-[10.5px] text-ink-3 sm:hidden">
					{inactive.map((f) => `○ ${NAME[f]}`).join(' · ')}{' '}
					<button type="button" className="underline" onClick={() => setShowAll(true)}>
						show all
					</button>
				</p>
			)}
			<dl className="num grid grid-cols-2 gap-x-4 gap-y-2.5 pt-3.5 text-data-s">
				<Metric
					label="Buy vs sell volume"
					value={`${usd(data.buyVolume)} / ${usd(data.sellVolume)}`}
				/>
				<Metric label="Held by bot-tagged" value={pct(data.botPct)} />
				<Metric label="Unique traders" value={int(data.uniqueTraders)} />
				<Metric
					label="Traders per trade"
					value={data.trades ? (data.uniqueTraders / data.trades).toFixed(2) : '—'}
				/>
			</dl>
		</section>
	)
}

const Metric = ({ label, value }: { label: string; value: string }) => (
	<div className="flex flex-col gap-px">
		<dt className="text-[9px] tracking-[0.08em] text-ink-3 uppercase">{label}</dt>
		<dd>{value}</dd>
	</div>
)
