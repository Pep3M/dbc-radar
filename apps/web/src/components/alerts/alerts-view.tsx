'use client'

import { useEffect, useRef, useState } from 'react'
import { Kicker, OfflineBanner, Section } from '@/components/ui'
import { type AlertDelivery, type AlertFired, type AlertsState, api, isNotFound } from '@/lib/api'
import { age, EMPTY, shortAddress } from '@/lib/format'
import { useNow, usePolling, useReducedMotion } from '@/lib/hooks'
import { look } from './look'
import { Destinations, TriggerEnvNote, Triggers } from './rules'

const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ')

const POLL_MS = 3000

const deliveryLine = (
	dest: AlertDelivery['dest'],
	alert: AlertFired,
	enabled: boolean,
	now: number,
): { text: string; className: string } => {
	const d = alert.deliveries.find((x) => x.dest === dest)
	const name = dest === 'webhook' ? 'webhook' : 'telegram'
	if (!d) {
		if (!enabled) return { text: `${name} off`, className: 'text-ink-3' }
		// Deliveries are written once every destination has answered (retries take a few seconds).
		const pending = now !== 0 && now - alert.ts < 30_000
		// No telegram record: no subscriber matched this alert.
		const idle = dest === 'telegram' ? 'telegram · no match' : `${name} —`
		return { text: pending ? `${name} sending…` : idle, className: 'text-ink-3' }
	}
	if (d.error === 'rate_limited')
		return { text: `${name} skipped · 1/min`, className: 'text-ink-3' }
	if (dest === 'telegram') {
		// Bot fan-out: `sent` / `failed` across subscribers (older rows: a single chat).
		if (d.sent != null)
			return d.ok
				? {
						text: `telegram ✓ ${d.sent}${d.failed ? ` · ${d.failed} failed` : ''}`,
						className: d.failed ? 'text-sell' : 'text-ink-2',
					}
				: {
						text: `telegram ✗ ${d.failed ?? ''} · ${d.status ?? d.error ?? ''}`,
						className: 'text-risk',
					}
		if (d.ok)
			return {
				text: d.attempts > 1 ? `telegram ✓ · retry ×${d.attempts - 1}` : 'telegram ✓',
				className: d.attempts > 1 ? 'text-sell' : 'text-ink-2',
			}
		return { text: `telegram ✗ ${d.status ?? d.error ?? ''}`.trim(), className: 'text-risk' }
	}
	if (d.ok)
		return d.attempts > 1
			? {
					text: `webhook ${d.status} · ${d.attempts - 1} ${d.attempts > 2 ? 'retries' : 'retry'} · ${d.ms}ms`,
					className: 'text-sell',
				}
			: { text: `webhook ${d.status} · ${d.ms}ms`, className: 'text-ink-2' }
	return {
		text: `webhook ✗ ${d.status ?? d.error ?? 'error'} · ${d.attempts}×`,
		className: 'text-risk',
	}
}

const FiredRow = ({
	alert,
	state,
	selected,
	onSelect,
	now,
}: {
	alert: AlertFired
	state: AlertsState
	selected: boolean
	onSelect: () => void
	now: number
}) => {
	const l = look(alert, state.rules.curve.threshold)
	const wh = deliveryLine('webhook', alert, state.destinations.webhook.enabled, now)
	const tg = deliveryLine('telegram', alert, state.destinations.telegram.enabled, now)
	return (
		<button
			type="button"
			data-alert={alert.id}
			aria-pressed={selected}
			onClick={onSelect}
			className={cx(
				'grid min-h-11 w-full grid-cols-[18px_minmax(0,1fr)_40px] items-center gap-x-3 gap-y-1 border-b border-line-soft px-2 py-1.5 text-left font-mono text-data tabular-nums transition-colors sm:grid-cols-[18px_112px_minmax(0,1fr)_150px_52px]',
				selected ? 'bg-bg-3' : 'hover:bg-bg-2',
			)}
		>
			<span aria-hidden="true" className={cx('text-center', l.glyphClass)}>
				{l.glyph}
			</span>
			<span className="flex min-w-0 flex-col gap-1 sm:contents">
				<span
					className={cx(
						'w-max px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.06em]',
						l.tagClass,
					)}
				>
					{l.tag}
				</span>
				<span className="truncate">
					<span className="font-sans text-[13.5px] font-semibold">
						{alert.symbol ?? shortAddress(alert.pool)}
					</span>{' '}
					<span className="text-ink-3">{alert.detail}</span>
				</span>
				<span className="flex min-w-0 flex-col gap-px overflow-hidden text-[10.5px] whitespace-nowrap max-sm:flex-row max-sm:gap-2">
					<span className={cx('truncate', wh.className)}>{wh.text}</span>
					<span className={cx('truncate', tg.className)}>{tg.text}</span>
				</span>
			</span>
			<span className="self-center text-right text-data-s text-ink-3">{age(alert.ts, now)}</span>
		</button>
	)
}

/** New rows slide down from -10px with an 18 % tint of their tag colour (800 ms). */
const useEnterAnimation = (
	root: React.RefObject<HTMLDivElement | null>,
	recent: AlertFired[] | undefined,
	threshold: number | undefined,
) => {
	const seen = useRef<Set<number> | null>(null)
	const reduced = useReducedMotion()
	useEffect(() => {
		if (!recent) return
		const prev = seen.current
		seen.current = new Set(recent.map((a) => a.id))
		if (!prev || reduced || !root.current) return
		for (const alert of recent) {
			if (prev.has(alert.id)) continue
			const el = root.current.querySelector<HTMLElement>(`[data-alert="${alert.id}"]`)
			el?.animate(
				[
					{
						opacity: 0,
						transform: 'translateY(-10px)',
						backgroundColor: `color-mix(in oklch, ${look(alert, threshold).tint} 18%, transparent)`,
					},
					{ opacity: 1, transform: 'none', backgroundColor: 'transparent' },
				],
				{ duration: 800, easing: 'cubic-bezier(.2,.8,.2,1)' },
			)
		}
	}, [recent, reduced, root, threshold])
}

/** Section without the soft rule under the title (Triggers / Destinations in the spec). */
const Panel = ({
	title,
	aside,
	children,
}: {
	title: string
	aside?: string
	children: React.ReactNode
}) => (
	<section className="min-w-0 border-t border-line">
		<header className="flex items-baseline justify-between gap-3 pt-4 pb-1">
			<h2 className="font-display text-section font-bold tracking-[0.03em] uppercase">{title}</h2>
			{aside && <span className="font-mono text-[10.5px] text-ink-3">{aside}</span>}
		</header>
		{children}
	</section>
)

const HeaderStat = ({ label, value }: { label: string; value: number | string }) => (
	<div className="flex flex-col gap-0.5">
		<span className="font-mono text-[9.5px] tracking-label text-ink-3">{label}</span>
		<span className="num font-display text-[44px] leading-none font-bold">{value}</span>
	</div>
)

const Previews = ({
	state,
	selected,
}: {
	state: AlertsState | null
	selected: AlertFired | null
}) => {
	const host = state?.destinations.webhook.host
	const l = selected && state ? look(selected, state.rules.curve.threshold) : null
	const name = selected ? (selected.symbol ?? selected.pool.slice(0, 6)) : ''
	return (
		<section className="flex flex-wrap gap-6">
			<div className="min-w-0 flex-[3_1_380px] border-t border-line">
				<header className="flex items-baseline justify-between gap-3 pt-4 pb-3">
					<h2 className="font-display text-section font-bold tracking-[0.03em] uppercase">
						Webhook payload
					</h2>
					<span className="truncate font-mono text-[10.5px] text-ink-3">
						{host ? `POST ${host}` : 'POST · no webhook configured'}
					</span>
				</header>
				<pre className="m-0 min-h-[120px] border border-line-soft bg-bg-2 px-[18px] py-4 font-mono text-[11.5px] leading-[1.6] break-all whitespace-pre-wrap text-ink-2">
					{selected
						? JSON.stringify(selected.payload, null, 2)
						: '// The exact JSON body of the first alert lands here.'}
				</pre>
			</div>
			<div className="min-w-0 flex-[2_1_260px] border-t border-line">
				<header className="flex items-baseline justify-between gap-3 pt-4 pb-3">
					<h2 className="font-display text-section font-bold tracking-[0.03em] uppercase">
						Telegram
					</h2>
				</header>
				<div className="flex flex-col gap-2 border border-line-soft bg-bg-2 px-4 py-3.5 text-[13.5px] leading-[1.45]">
					{selected && l ? (
						<>
							<span className={cx('font-semibold', l.glyphClass)}>
								{l.glyph} {name} · {l.telegramLabel}
							</span>
							<span className="text-ink-2">{selected.detail}</span>
							<span className="font-mono text-data-s break-all text-ink-3 underline">
								{selected.payload.url.replace(/^https?:\/\//, '')}
							</span>
						</>
					) : (
						<span className="font-mono text-data-s text-ink-3">No message yet.</span>
					)}
				</div>
			</div>
		</section>
	)
}

export const AlertsView = () => {
	const { data, error } = usePolling(api.alerts, POLL_MS)
	const now = useNow(1000)
	const [selectedId, setSelectedId] = useState<number | null>(null)
	const listRef = useRef<HTMLDivElement>(null)
	useEnterAnimation(listRef, data?.recent, data?.rules.curve.threshold)

	const missing = isNotFound(error)
	const offline = !!error && !missing
	const recent = data?.recent ?? []
	const selected = recent.find((a) => a.id === selectedId) ?? recent[0] ?? null

	return (
		<div className="flex flex-col">
			{offline && <OfflineBanner />}
			<div
				className={cx(
					'mx-auto flex w-full max-w-[1520px] flex-col gap-9 px-4 pt-9 pb-14 sm:px-8',
					offline && data && 'opacity-50 grayscale',
				)}
			>
				<div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-4">
					<div className="flex flex-col gap-3">
						<Kicker>Alerts</Kicker>
						<h1 className="m-0 max-w-[18ch] font-display text-[clamp(40px,4.4vw,64px)] leading-[0.95] font-bold text-balance">
							Get pinged before the curve fills
						</h1>
					</div>
					<div className="flex gap-7">
						<HeaderStat label="FIRED 1H" value={data?.stats.fired1h ?? EMPTY} />
						<HeaderStat label="DELIVERED 24H" value={data?.stats.delivered ?? EMPTY} />
						<HeaderStat label="ACTIVE RULES" value={data?.stats.activeRules ?? EMPTY} />
					</div>
				</div>

				{missing && (
					<p className="hatch-ink border border-line px-4 py-3 font-mono text-data text-ink-2">
						This indexer build doesn&apos;t expose <code className="text-ink">/api/alerts</code>{' '}
						yet. Rules and fired alerts appear here once it does.
					</p>
				)}

				<div className="flex flex-wrap items-start gap-x-12 gap-y-9">
					<div className="flex min-w-0 flex-[1_1_440px] flex-col gap-9">
						<Panel title="Triggers" aside="any pool on the radar">
							<Triggers rules={data?.rules ?? null} />
							<TriggerEnvNote rules={data?.rules ?? null} />
						</Panel>
						<Panel title="Destinations">
							<Destinations dest={data?.destinations ?? null} />
						</Panel>
					</div>

					<div className="flex min-w-0 flex-[999_1_640px] flex-col gap-9">
						<Section title="Fired" aside="click a row to preview its payload">
							<div ref={listRef} className="flex flex-col">
								{!data ? (
									<p className="py-8 font-mono text-data text-ink-3">
										{missing
											? 'Alerts endpoint not available.'
											: offline
												? 'Indexer unreachable.'
												: 'Loading alerts…'}
									</p>
								) : recent.length === 0 ? (
									<p className="py-8 font-mono text-data text-ink-3">
										Listening… nothing has fired yet.
									</p>
								) : (
									data &&
									recent.map((alert) => (
										<FiredRow
											key={alert.id}
											alert={alert}
											state={data}
											selected={selected?.id === alert.id}
											onSelect={() => setSelectedId(alert.id)}
											now={now}
										/>
									))
								)}
							</div>
						</Section>
						<Previews state={data} selected={selected} />
					</div>
				</div>
			</div>
		</div>
	)
}
