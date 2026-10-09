import type { ReactNode } from 'react'
import { FLAG_HINT, FLAG_LABEL, FLAG_WEIGHT } from '@/components/ui'
import type { AlertsState, RiskFlag } from '@/lib/api'
import { duration } from '@/lib/format'

/*
 * Read-only views of the alert configuration. Alerts are configured with server env vars
 * only (no public write API), so the switches, segmented control and chips below are
 * status indicators with the design's look, never buttons.
 */

const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ')

const ALL_FLAGS: RiskFlag[] = [
	'creator_sold',
	'whale_buyer',
	'concentrated',
	'wash_trading',
	'dumping',
	'fresh_wallets',
]

/** 34×18 square switch, as a status light: ON = ink fill, knob right. */
export const StatusSwitch = ({ on, label }: { on: boolean | null; label: string }) => (
	<span
		className="flex shrink-0 items-center gap-2"
		role="img"
		aria-label={`${label}: ${on ? 'on' : 'off'}`}
	>
		<span
			aria-hidden="true"
			className={cx('font-mono text-[9.5px] tracking-label', on ? 'text-ink-2' : 'text-ink-3')}
		>
			{on == null ? '—' : on ? 'ON' : 'OFF'}
		</span>
		<span
			aria-hidden="true"
			className={cx(
				'relative h-[18px] w-[34px] border-[1.5px]',
				on ? 'border-ink bg-ink' : 'border-ink-3',
			)}
		>
			<span
				className={cx(
					'absolute top-[2px] size-[11px]',
					on ? 'left-[17px] bg-bg' : 'left-[2px] bg-ink-3',
				)}
			/>
		</span>
	</span>
)

const Rule = ({
	icon,
	title,
	hint,
	on,
	children,
}: {
	icon: ReactNode
	title: ReactNode
	hint: ReactNode
	on: boolean | null
	children?: ReactNode
}) => (
	<div
		className={cx(
			'grid grid-cols-[44px_minmax(0,1fr)_auto] items-start gap-3.5 border-b border-line-soft py-[18px]',
			on === false && 'opacity-60',
		)}
	>
		{icon}
		<div className="flex min-w-0 flex-col gap-2.5">
			<div className="flex flex-col gap-0.5">
				<span className="text-[15px] font-semibold">{title}</span>
				<span className="text-[12.5px] leading-[1.4] text-ink-3">{hint}</span>
			</div>
			{children}
		</div>
		<StatusSwitch on={on} label={typeof title === 'string' ? title : 'rule'} />
	</div>
)

const THRESHOLDS = [0.7, 0.8, 0.9]

export const Triggers = ({ rules }: { rules: AlertsState['rules'] | null }) => {
	const threshold = rules?.curve.threshold ?? 0.8
	const at = Math.round(threshold * 100)
	const options = THRESHOLDS.some((v) => Math.abs(v - threshold) < 1e-6)
		? THRESHOLDS
		: [...THRESHOLDS, threshold].sort((a, b) => a - b)
	const skip = rules?.graduated.skipFastMs ?? 0
	const flags = rules?.risk.flags ?? []
	return (
		<>
			<Rule
				on={rules ? rules.curve.enabled : null}
				icon={
					<svg
						width="44"
						height="28"
						viewBox="0 0 44 28"
						className="overflow-visible"
						aria-hidden="true"
					>
						<path
							d="M1 26 C 18 26, 32 20, 43 2"
							fill="none"
							strokeWidth="1.5"
							className="stroke-line"
						/>
						<path
							d="M1 26 C 18 26, 32 20, 43 2"
							fill="none"
							pathLength={100}
							strokeDasharray={`${at} 100`}
							strokeWidth="2.4"
							strokeLinecap="round"
							className="stroke-signal"
						/>
					</svg>
				}
				title={rules ? `Curve crosses ${at}%` : 'Curve crosses —'}
				hint="Fires once per pool, the moment quote reserve passes the mark."
			>
				<span
					className="flex w-max border border-line font-mono text-data-s"
					role="img"
					aria-label={`Threshold ${at}%`}
				>
					{options.map((v) => {
						const active = rules != null && Math.abs(v - threshold) < 1e-6
						return (
							<span
								key={v}
								aria-hidden="true"
								className={cx('px-2.5 py-[5px]', active ? 'bg-ink text-bg' : 'text-ink-3')}
							>
								{Math.round(v * 100)}%
							</span>
						)
					})}
				</span>
			</Rule>
			<Rule
				on={rules ? rules.graduated.enabled : null}
				icon={
					<span aria-hidden="true" className="text-center text-[24px] leading-none text-signal">
						◉
					</span>
				}
				title="Pool graduates"
				hint="Curve completed and migrating to DAMM v2."
			>
				<span className="flex items-center gap-2 font-mono text-data-s text-ink-2">
					<span
						aria-hidden="true"
						className={cx('size-3 border', skip > 0 ? 'border-ink bg-ink' : 'border-ink-3')}
					/>
					{skip > 0
						? `Skip graduations under ${skip % 60_000 === 0 ? `${skip / 60_000} min` : duration(skip)} (likely bundles)`
						: 'Every graduation, bundles included'}
				</span>
			</Rule>
			<Rule
				on={rules ? rules.risk.enabled : null}
				icon={
					<span aria-hidden="true" className="text-center text-[24px] leading-none text-risk">
						◆
					</span>
				}
				title="Strong risk flag raised"
				hint="Fires when a selected flag appears on a pool you could be holding."
			>
				<ul className="flex flex-wrap gap-1.5 font-mono text-[10.5px]">
					{ALL_FLAGS.map((flag) => {
						const on = flags.includes(flag)
						return (
							<li
								key={flag}
								title={`${FLAG_HINT[flag]}${on ? ' · alerting' : ' · not selected'}`}
								className={cx(
									'border px-[7px] py-[3px]',
									on ? 'border-risk bg-risk text-risk-ink' : 'border-line text-ink-3',
								)}
							>
								{on && <span className="sr-only">selected: </span>}
								{FLAG_LABEL[flag]} +{FLAG_WEIGHT[flag]}
							</li>
						)
					})}
				</ul>
			</Rule>
		</>
	)
}

/** One `ENV_VAR = value` line in the config notes. */
const EnvLine = ({ name, value, set }: { name: string; value: ReactNode; set: boolean }) => (
	<div className="flex min-w-0 items-baseline justify-between gap-3 py-[3px]">
		<code className="shrink-0 text-ink">{name}</code>
		<span className={cx('min-w-0 truncate text-right', set ? 'text-ink-2' : 'text-ink-3')}>
			{value}
		</span>
	</div>
)

const EnvBox = ({ children }: { children: ReactNode }) => (
	<div className="flex flex-col border border-line bg-bg-2 px-2.5 py-2 font-mono text-data-s">
		{children}
	</div>
)

export const TriggerEnvNote = ({ rules }: { rules: AlertsState['rules'] | null }) => (
	<div className="flex flex-col gap-2 pt-[18px]">
		<EnvBox>
			<EnvLine
				name="ALERT_CURVE_THRESHOLD"
				value={rules ? (rules.curve.enabled ? String(rules.curve.threshold) : 'off') : '—'}
				set={!!rules?.curve.enabled}
			/>
			<EnvLine
				name="ALERT_SKIP_FAST_GRADUATIONS_MS"
				value={rules ? String(rules.graduated.skipFastMs) : '—'}
				set={!!rules?.graduated.enabled}
			/>
			<EnvLine
				name="ALERT_FLAGS"
				value={rules ? rules.risk.flags.join(',') || 'none' : '—'}
				set={!!rules?.risk.enabled}
			/>
		</EnvBox>
		<span className="font-mono text-[10.5px] leading-[1.5] text-ink-3">
			Read-only: rules are set with server env vars, there is no public write API. Set{' '}
			<code className="text-ink-2">ALERT_GRADUATIONS=0</code> to mute graduations.
		</span>
	</div>
)

type Dest = AlertsState['destinations'] | null

const statusText = (enabled: boolean, lastStatus: number | null, idle: string) =>
	!enabled
		? idle
		: lastStatus == null
			? 'active · no deliveries yet'
			: `active · last delivery ${lastStatus}`

export const Destinations = ({ dest }: { dest: Dest }) => {
	const wh = dest?.webhook
	const tg = dest?.telegram
	return (
		<>
			<div className="flex flex-col gap-3 border-b border-line-soft py-[18px]">
				<div className="flex items-center justify-between gap-3">
					<div className="flex flex-col gap-0.5">
						<span className="text-[15px] font-semibold">Webhook</span>
						<span
							className={cx(
								'font-mono text-[10.5px]',
								wh?.enabled
									? wh.lastStatus != null && wh.lastStatus >= 300
										? 'text-sell'
										: 'text-ink-2'
									: 'text-ink-3',
							)}
						>
							{wh ? statusText(wh.enabled, wh.lastStatus, 'off · no URL configured') : '—'}
						</span>
					</div>
					<StatusSwitch on={wh ? wh.enabled : null} label="Webhook" />
				</div>
				<EnvBox>
					<EnvLine
						name="ALERT_WEBHOOK_URL"
						value={wh ? (wh.host ? `https://${wh.host}/…` : 'not set') : '—'}
						set={!!wh?.enabled}
					/>
					<EnvLine
						name="ALERT_WEBHOOK_SECRET"
						value={wh ? (wh.signed ? 'set · requests signed' : 'not set · unsigned') : '—'}
						set={!!wh?.signed}
					/>
				</EnvBox>
				<span className="font-mono text-[10.5px] leading-[1.5] text-ink-3">
					POST · JSON · signed with X-DBC-Signature (HMAC-SHA256) · 3 retries with backoff
				</span>
			</div>
			<TelegramDest tg={tg ?? null} />
		</>
	)
}

const COMMANDS: [string, string][] = [
	['/start', 'subscribe (curve 80%, graduations, creator sold)'],
	['/threshold 50|70|80|90', 'your curve level'],
	['/flags', 'pick risk flags'],
	['/grads on|off', 'graduations'],
	['/stop', 'unsubscribe'],
]

type TelegramState = NonNullable<Dest>['telegram']

const TelegramDest = ({ tg }: { tg: TelegramState | null }) => {
	// Older indexer builds don't send the bot fields.
	const bot = tg?.botUsername ?? null
	const subs = tg?.subscribers ?? null
	const status = !tg
		? '—'
		: !tg.enabled
			? 'off · no bot configured'
			: [
					bot ? `@${bot}` : 'bot starting…',
					subs != null && `${subs} ${subs === 1 ? 'subscriber' : 'subscribers'}`,
					tg.lastStatus != null && `last delivery ${tg.lastStatus}`,
				]
					.filter(Boolean)
					.join(' · ')
	return (
		<div className="flex flex-col gap-3 border-b border-line-soft py-[18px]">
			<div className="flex items-center justify-between gap-3">
				<div className="flex min-w-0 flex-col gap-0.5">
					<span className="text-[15px] font-semibold">Telegram</span>
					<span
						className={cx(
							'truncate font-mono text-[10.5px]',
							tg?.enabled ? 'text-ink-2' : 'text-ink-3',
						)}
					>
						{status}
					</span>
				</div>
				<StatusSwitch on={tg ? tg.enabled : null} label="Telegram" />
			</div>
			{tg?.enabled && bot ? (
				<>
					<a
						href={`https://t.me/${bot}`}
						target="_blank"
						rel="noopener noreferrer"
						className="flex items-center justify-between gap-3 bg-ink px-3.5 py-3 font-mono text-[11.5px] tracking-[0.06em] text-bg uppercase transition-colors hover:bg-ink-2"
					>
						<span>Get these on Telegram →</span>
						<span className="normal-case tracking-normal">@{bot}</span>
					</a>
					<EnvBox>
						{COMMANDS.map(([cmd, hint]) => (
							<div key={cmd} className="flex min-w-0 items-baseline justify-between gap-3 py-[3px]">
								<code className="shrink-0 text-ink">{cmd}</code>
								<span className="min-w-0 truncate text-right text-ink-3">{hint}</span>
							</div>
						))}
					</EnvBox>
					<span className="font-mono text-[10.5px] leading-[1.5] text-ink-3">
						Free, per chat: each subscriber picks their own curve level (50–90%) and flags. Tap the
						buttons in the bot to change them.
					</span>
				</>
			) : (
				<span className="font-mono text-[10.5px] leading-[1.5] text-ink-3">
					{tg?.enabled
						? 'The bot is starting: its link appears here in a moment.'
						: 'Set TELEGRAM_BOT_TOKEN on the indexer to run the subscriber bot (optional TELEGRAM_CHAT_ID adds a fixed channel).'}
				</span>
			)}
		</div>
	)
}
