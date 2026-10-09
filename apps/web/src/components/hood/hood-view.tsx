'use client'

import type { ReactNode } from 'react'
import { api, isNotFound } from '@/lib/api'
import { usePolling } from '@/lib/hooks'
import { DataPath } from './data-path'
import { LatencyChart, windowMs } from './latency'
import { Race } from './race'

const SectionHead = ({ title, aside }: { title: string; aside: ReactNode }) => (
	<div className="flex flex-wrap items-baseline justify-between gap-3 border-t border-line border-b border-b-line-soft pt-4 pb-3">
		<h2 className="font-display text-section font-bold tracking-[0.03em] uppercase">{title}</h2>
		<span className="font-mono text-[10.5px] text-ink-3">{aside}</span>
	</div>
)

export const HoodView = () => {
	const { data: pipeline, error } = usePolling(api.pipeline, 2000)
	const missing = isNotFound(error)
	const stale = !!error && !missing
	const note = missing
		? 'This indexer build has no /api/pipeline yet: the race below still runs live.'
		: stale
			? 'Indexer unreachable: pipeline numbers are frozen, not live.'
			: null

	return (
		<div className="flex flex-col">
			<Race headline={<>Public RPC makes you ask, one call at a time. Solami keeps streaming.</>} />

			<section className="mx-auto w-full max-w-[1520px] px-4 pb-14 sm:px-8">
				<SectionHead title="Data path" aside="every dot is one message in flight" />
				{note && (
					<p className="hatch-sell mt-4 border border-line px-4 py-3 font-mono text-data text-ink-2">
						{note}
					</p>
				)}
				<div className={stale ? 'opacity-50 grayscale' : undefined}>
					<DataPath pipeline={missing ? null : pipeline} />
				</div>
			</section>

			<section className="mx-auto w-full max-w-[1520px] px-4 pb-14 sm:px-8">
				<SectionHead
					title="gRPC vs Blur · latency per signature"
					aside={
						<span className="flex flex-wrap gap-[18px]">
							<span className="flex items-center gap-1.5">
								<span className="size-2 rounded-full bg-signal" />
								gRPC
							</span>
							<span className="flex items-center gap-1.5">
								<span className="size-2 rounded-full border-[1.5px] border-ink-2" />
								Blur
							</span>
							<span>
								slot seen → arrival · last {Math.round(windowMs(pipeline) / 1000)}s · log scale
							</span>
						</span>
					}
				/>
				<div className={stale ? 'opacity-50 grayscale' : undefined}>
					<LatencyChart pipeline={missing ? null : pipeline} />
				</div>
			</section>
		</div>
	)
}
