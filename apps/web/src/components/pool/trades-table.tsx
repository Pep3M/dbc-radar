'use client'

import { useLayoutEffect, useRef } from 'react'
import type { PoolDetail } from '@/lib/api'
import { age, int, links, shortAddress, usd } from '@/lib/format'
import { useReducedMotion } from '@/lib/hooks'
import { quotePrice, usdPerQuote } from './model'

const COLS =
	'grid-cols-[62px_minmax(0,1fr)_auto_34px] gap-2 sm:grid-cols-[150px_minmax(0,1fr)_90px_110px_56px_100px] sm:gap-3'

/**
 * Recent trades, newest first. New rows slide in with a 700 ms tint in their side colour
 * (risk for the creator); reduced motion keeps the tint only. Creator rows carry a red
 * "(creator)" marker and a faint risk wash.
 */
export const TradesTable = ({
	data,
	now,
	limit = 14,
	className,
}: {
	data: PoolDetail
	now: number
	limit?: number
	className?: string
}) => {
	const trades = (data.recentTrades ?? []).slice(0, limit)
	const rate = usdPerQuote(data)
	const quote = data.quoteSymbol ?? 'SOL'
	const reduced = useReducedMotion()
	const listRef = useRef<HTMLDivElement>(null)
	const seen = useRef<Set<string> | null>(null)

	useLayoutEffect(() => {
		const root = listRef.current
		if (!root) return
		const current = new Set<string>()
		for (const el of root.querySelectorAll<HTMLElement>('[data-sig]')) {
			const sig = el.dataset.sig as string
			current.add(sig)
			if (seen.current && !seen.current.has(sig)) {
				const color = el.dataset.creator
					? 'var(--color-risk)'
					: el.dataset.side === 'buy'
						? 'var(--color-buy)'
						: 'var(--color-sell)'
				const tint = `color-mix(in oklch, ${color} 18%, transparent)`
				el.animate(
					reduced
						? [
								{ backgroundColor: tint },
								{ backgroundColor: tint, offset: 0.6 },
								{ backgroundColor: 'transparent' },
							]
						: [
								{ opacity: 0, transform: 'translateY(-10px)', backgroundColor: tint },
								{ opacity: 1, transform: 'none', backgroundColor: 'transparent' },
							],
					{ duration: reduced ? 1000 : 700, easing: 'cubic-bezier(.2,.8,.2,1)' },
				)
			}
		}
		seen.current = current
	})

	return (
		<section className={`min-w-0 border-t border-line ${className ?? ''}`}>
			<header className="flex items-baseline justify-between gap-3 border-b border-line-soft pt-3 pb-1.5 sm:pt-4 sm:pb-3">
				<h2 className="font-display text-[18px] font-bold tracking-[0.03em] uppercase sm:text-section">
					Recent trades
				</h2>
				<span className="font-mono text-[10.5px] text-ink-3">{int(data.trades)} total</span>
			</header>
			{trades.length === 0 ? (
				<p className="py-8 font-mono text-data text-ink-3">No trades seen on this curve yet.</p>
			) : (
				<div className="sm:overflow-x-auto">
					<div ref={listRef} className="sm:min-w-[600px]">
						<div
							className={`hidden h-[30px] items-center border-b border-line-soft font-mono text-label tracking-label text-ink-3 uppercase sm:grid ${COLS}`}
						>
							<span>Side</span>
							<span>Trader</span>
							<span className="text-right">USD</span>
							<span className="text-right">Price</span>
							<span className="text-right">Age</span>
							<span className="text-right">Tx</span>
						</div>
						{trades.map((t) => {
							const creator = data.creator != null && t.trader === data.creator
							return (
								<div
									key={t.signature}
									data-sig={t.signature}
									data-side={t.side}
									data-creator={creator ? '1' : undefined}
									className={`num grid h-11 items-center border-b border-line-soft text-[11.5px] sm:h-[34px] sm:text-data ${COLS} ${creator ? 'bg-[color-mix(in_oklch,var(--color-risk)_10%,transparent)]' : ''}`}
								>
									<span className="flex items-baseline gap-1.5 whitespace-nowrap">
										<span className={t.side === 'buy' ? 'text-buy' : 'text-sell'}>
											{t.side === 'buy' ? '▲' : '▼'} {t.side}
										</span>
										{creator && (
											<span className="text-[10.5px] font-semibold text-risk max-sm:hidden">
												(creator)
											</span>
										)}
										{creator && (
											<span className="text-risk sm:hidden" title="creator">
												◆
											</span>
										)}
									</span>
									<a
										href={links.solscanAccount(t.trader)}
										target="_blank"
										rel="noopener noreferrer"
										className="truncate text-ink-2 no-underline hover:text-signal"
									>
										{shortAddress(t.trader)}
									</a>
									<span className="text-right">{usd(t.usd_amount)}</span>
									<span className="hidden text-right text-ink-2 sm:block">
										{quotePrice(t.price, rate, quote)}
									</span>
									<span className="text-right text-ink-3">{age(t.ts, now)}</span>
									<a
										href={links.solscanTx(t.signature)}
										target="_blank"
										rel="noopener noreferrer"
										className="hidden text-right text-ink-2 underline decoration-line underline-offset-[3px] hover:text-signal sm:block"
									>
										{shortAddress(t.signature)}
									</a>
								</div>
							)
						})}
					</div>
				</div>
			)}
		</section>
	)
}
