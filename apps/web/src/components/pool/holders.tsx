'use client'

import type { PoolDetail } from '@/lib/api'
import { int, links, pct, shortAddress } from '@/lib/format'

const TAG_CLASS = {
	creator: 'border-risk text-risk',
	bot: 'border-ink-2 text-ink-2',
	fresh: 'border-ink-2 bg-bg-3 text-ink-2',
} as const

/**
 * Top holders (curve / DAMM vaults excluded) with share bars relative to the largest holder
 * and CREATOR / BOT / FRESH tags, from the Solami Data API via the indexer.
 */
export const Holders = ({ data, className }: { data: PoolDetail; className?: string }) => {
	const holders = (data.holdersTop ?? []).slice(0, 12)
	const max = holders.reduce((a, h) => Math.max(a, h.pct), 0) || 1
	return (
		<section className={`min-w-0 border-t border-line ${className ?? ''}`}>
			<header className="flex items-baseline justify-between gap-3 border-b border-line-soft pt-3 pb-2 sm:pt-4 sm:pb-3">
				<h2 className="font-display text-[18px] font-bold tracking-[0.03em] uppercase sm:text-section">
					Holders
				</h2>
				<span className="text-right font-mono text-[10.5px] text-ink-3">
					top 10 hold {pct(data.top10Pct)} · curve vault excluded
				</span>
			</header>
			{holders.length === 0 ? (
				<p className="py-8 font-mono text-data text-ink-3">
					Waiting for the holder snapshot from Solami Data API…
				</p>
			) : (
				<ol>
					{holders.map((h, i) => {
						const creator = h.tags.includes('creator') || h.address === data.creator
						return (
							<li
								key={h.address}
								className="num grid h-8 grid-cols-[22px_92px_minmax(0,1fr)_54px_minmax(0,96px)] items-center gap-2.5 border-b border-line-soft text-data-s max-sm:grid-cols-[18px_84px_minmax(0,1fr)_48px_44px] max-sm:gap-2"
							>
								<span className="text-ink-3">{i + 1}</span>
								<a
									href={links.solscanAccount(h.address)}
									target="_blank"
									rel="noopener noreferrer"
									className="text-ink-2 no-underline hover:text-signal"
								>
									{shortAddress(h.address)}
								</a>
								<div className="h-2 bg-bg-3">
									<div
										className={`h-full transition-[width] duration-600 ease-out ${creator ? 'bg-risk' : 'bg-ink-3'}`}
										style={{ width: `${((h.pct / max) * 100).toFixed(1)}%` }}
									/>
								</div>
								<span className="text-right">{pct(h.pct)}</span>
								<div className="flex justify-end gap-1">
									{[...new Set([...(creator ? ['creator' as const] : []), ...h.tags])].map(
										(tag) => (
											<span
												key={tag}
												className={`border px-1 py-px text-[8.5px] font-semibold tracking-[0.06em] uppercase ${TAG_CLASS[tag]}`}
											>
												{tag}
											</span>
										),
									)}
								</div>
							</li>
						)
					})}
				</ol>
			)}
			<p className="pt-2.5 font-mono text-[10.5px] text-ink-3">
				{int(data.holders)} holders · {data.freshHolders ?? '—'} fresh wallets in top 20 · via
				Solami Data API
			</p>
		</section>
	)
}
