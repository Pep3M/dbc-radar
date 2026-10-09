import type { ReactNode } from 'react'
import type { RiskFlag } from '@/lib/api'

export const ProgressBar = ({
	value,
	graduated,
}: {
	value: number | null
	graduated?: boolean
}) => {
	const pct = Math.round((value ?? 0) * 100)
	const color = graduated
		? 'bg-violet-400'
		: pct >= 80
			? 'bg-emerald-400'
			: pct >= 40
				? 'bg-amber-400'
				: 'bg-sky-500'
	return (
		<div className="flex items-center gap-2">
			<div className="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
				<div className={`h-full ${color} transition-all`} style={{ width: `${pct}%` }} />
			</div>
			<span className="w-10 text-right font-mono text-xs tabular-nums text-white/70">{pct}%</span>
		</div>
	)
}

const FLAG_LABEL: Record<RiskFlag, string> = {
	creator_sold: 'creator sold',
	whale_buyer: 'whale buyer',
	wash_trading: 'wash trading',
	dumping: 'dumping',
}

export const RiskBadge = ({ score, flags }: { score: number; flags: RiskFlag[] }) => {
	const tone =
		score >= 40
			? 'border-red-500/40 bg-red-500/10 text-red-300'
			: score > 0
				? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
				: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
	return (
		<span
			title={flags.length ? flags.map((f) => FLAG_LABEL[f]).join(', ') : 'no flags'}
			className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[11px] ${tone}`}
		>
			{score}
			{flags.length > 0 && <span className="text-white/50">·{flags.length}</span>}
		</span>
	)
}

export const RiskFlags = ({ flags }: { flags: RiskFlag[] }) =>
	flags.length === 0 ? (
		<span className="text-sm text-emerald-300">No risk flags detected from flow</span>
	) : (
		<div className="flex flex-wrap gap-2">
			{flags.map((flag) => (
				<span
					key={flag}
					className="rounded border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-xs text-red-300"
				>
					{FLAG_LABEL[flag]}
				</span>
			))}
		</div>
	)

export const Stat = ({
	label,
	value,
	hint,
}: {
	label: string
	value: ReactNode
	hint?: string
}) => (
	<div className="rounded-lg border border-white/10 bg-white/[0.03] px-4 py-3">
		<div className="text-[11px] uppercase tracking-wider text-white/45">{label}</div>
		<div className="mt-1 font-mono text-xl tabular-nums">{value}</div>
		{hint && <div className="mt-0.5 text-[11px] text-white/40">{hint}</div>}
	</div>
)

export const ExternalLink = ({ href, children }: { href: string; children: ReactNode }) => (
	<a
		href={href}
		target="_blank"
		rel="noopener noreferrer"
		className="text-sky-300 underline-offset-2 hover:underline"
	>
		{children}
	</a>
)
