'use client'

import Link from 'next/link'
import {
	type ComponentProps,
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useRef,
	useState,
} from 'react'
import type { RiskFlag } from '@/lib/api'
import { progressPct, seconds } from '@/lib/format'
import { type LiveListener, useChangeTick, useReducedMotion } from '@/lib/hooks'

/*
 * DBC Radar primitives. Rules (design handoff):
 * - Radius 0 everywhere; `rounded-chip` (2px) for chips; circles only for blips, avatars, live dot.
 * - `signal` (amber) only for completion: graduation, curve >= 80 %, sweep.
 * - Buy = blue ▲, sell = orange ▼, risk = red ◆ + hatch. Never colour alone.
 * - Elevation through lines (`border-line`, `border-line-soft`, `bg-bg-2`); `shadow-float` only
 *   for hover cards and toasts.
 * - Numbers: `num` utility (Spline Sans Mono + tabular-nums).
 */

const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ')

// Token metadata is creator-controlled: only plain http(s) URLs become links or images.
export const isSafeUrl = (href: string | null | undefined): href is string =>
	!!href && /^https?:\/\//i.test(href)

/* ───────────────────────────── Mark ───────────────────────────── */

/** Range ring with a bonding curve breaking orbit. Stroke weights follow the spec per size. */
export const LogoMark = ({ size = 28, className }: { size?: number; className?: string }) => {
	const small = size <= 24
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 32 32"
			className={cx('shrink-0', className)}
			aria-hidden="true"
		>
			<circle
				cx="16"
				cy="16"
				r="12.5"
				fill="none"
				strokeWidth={small ? 1.8 : 1.5}
				className="stroke-ink"
			/>
			<path
				d="M4.5 25 C 15 25, 22 20, 27.5 7.5"
				fill="none"
				strokeWidth={small ? 2.6 : 2.2}
				strokeLinecap="round"
				className="stroke-signal"
			/>
			<circle cx="28.4" cy="5.6" r={small ? 2.6 : 2.4} className="fill-signal" />
		</svg>
	)
}

/** Mark + "DBC RADAR" wordmark (Big Shoulders 800, 0.07em). */
export const Wordmark = ({ size = 28, className }: { size?: number; className?: string }) => (
	<span className={cx('flex items-center gap-2.5', className)}>
		<LogoMark size={size} />
		<span
			className="font-display font-extrabold leading-none tracking-[0.07em]"
			style={{ fontSize: Math.round(size * 0.79) }}
		>
			DBC RADAR
		</span>
	</span>
)

/* ───────────────────────────── Text ───────────────────────────── */

/** Mono micro label: 9.5px, 0.1em, uppercase, ink-3 (`tone="signal"` for completion stats). */
export const Label = ({
	children,
	tone = 'default',
	className,
}: {
	children: ReactNode
	tone?: 'default' | 'signal' | 'risk'
	className?: string
}) => (
	<span
		className={cx(
			'label',
			tone === 'signal' && 'text-signal',
			tone === 'risk' && 'text-risk',
			className,
		)}
	>
		{children}
	</span>
)

/** Mono kicker above headlines: 11px, 0.14em, amber (`METEORA DBC · SOLANA MAINNET`). */
export const Kicker = ({
	children,
	tone = 'signal',
	className,
}: {
	children: ReactNode
	tone?: 'signal' | 'muted'
	className?: string
}) => (
	<span
		className={cx(
			'font-mono text-data-s tracking-[0.14em] uppercase',
			tone === 'signal' ? 'text-signal' : 'text-ink-3',
			className,
		)}
	>
		{children}
	</span>
)

/**
 * Section header: hairline top rule, display title (21px caps), optional count and a mono
 * aside on the right, soft rule below. Children render under the header.
 */
export const Section = ({
	title,
	count,
	aside,
	id,
	children,
	className,
	headerClassName,
}: {
	title: ReactNode
	count?: ReactNode
	aside?: ReactNode
	id?: string
	children?: ReactNode
	className?: string
	headerClassName?: string
}) => (
	<section id={id} className={cx('min-w-0 border-t border-line', className)}>
		<header
			className={cx(
				'flex items-baseline justify-between gap-3 border-b border-line-soft pt-4 pb-3',
				headerClassName,
			)}
		>
			<h2 className="flex items-baseline gap-2 font-display text-section font-bold tracking-[0.03em] uppercase">
				{title}
				{count != null && (
					<span className="font-mono text-data-s font-normal tracking-normal text-ink-3">
						{count}
					</span>
				)}
			</h2>
			{aside && <span className="text-right font-mono text-[10px] text-ink-3">{aside}</span>}
		</header>
		{children}
	</section>
)

/* ───────────────────────────── Links & buttons ───────────────────────────── */

/** External link (new tab, no referrer). Renders nothing for non-http(s) hrefs. */
export const ExternalLink = ({
	href,
	children,
	className,
	title,
}: {
	href: string | null | undefined
	children: ReactNode
	className?: string
	title?: string
}) =>
	isSafeUrl(href) ? (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			title={title}
			className={cx(
				'text-ink-2 underline decoration-line underline-offset-[3px] transition-colors hover:text-signal hover:decoration-signal',
				className,
			)}
		>
			{children}
		</a>
	) : null

const buttonClass = (variant: 'solid' | 'outline', size: 'md' | 'sm') =>
	cx(
		'inline-flex items-center justify-center gap-2 font-mono tracking-[0.06em] uppercase transition-colors',
		size === 'md' ? 'px-4 py-2.5 text-[11.5px]' : 'px-2.5 py-1.5 text-data-s',
		variant === 'solid'
			? 'bg-ink text-bg hover:bg-ink-2'
			: 'border border-ink text-ink hover:bg-bg-2',
	)

type ButtonStyle = { variant?: 'solid' | 'outline'; size?: 'md' | 'sm' }

/** Square mono button (`← BACK TO RADAR`, `RETRY NOW`). */
export const Button = ({
	variant = 'outline',
	size = 'md',
	className,
	type = 'button',
	...props
}: ComponentProps<'button'> & ButtonStyle) => (
	<button type={type} className={cx(buttonClass(variant, size), className)} {...props} />
)

/** Button-styled link. Internal hrefs use next/link; http(s) hrefs open in a new tab. */
export const ButtonLink = ({
	href,
	variant = 'outline',
	size = 'md',
	className,
	children,
}: ButtonStyle & { href: string; className?: string; children: ReactNode }) => {
	const classes = cx(buttonClass(variant, size), className)
	if (isSafeUrl(href)) {
		return (
			<a href={href} target="_blank" rel="noopener noreferrer" className={classes}>
				{children}
			</a>
		)
	}
	return (
		<Link href={href} className={classes}>
			{children}
		</Link>
	)
}

/* ───────────────────────────── Token avatar ───────────────────────────── */

const hashHue = (seed: string) => {
	let h = 2166136261
	for (let i = 0; i < seed.length; i++) {
		h ^= seed.charCodeAt(i)
		h = Math.imul(h, 16777619)
	}
	return (h >>> 0) % 360
}

const segmenter =
	typeof Intl !== 'undefined' && 'Segmenter' in Intl
		? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
		: null

/** First two grapheme clusters, as given (Unicode and case preserved). */
export const initials = (label: string) => {
	const clean = label.replace(/^\$/, '').trim()
	if (!segmenter) return clean.slice(0, 2)
	const out: string[] = []
	for (const { segment } of segmenter.segment(clean)) {
		out.push(segment)
		if (out.length === 2) break
	}
	return out.join('')
}

/**
 * Token logo (circle). Falls back to initials on a disc coloured `oklch(.44 .07 hue)` with the
 * hue hashed from `seed` (pass the mint) when there is no image, it is not http(s), or the CDN
 * blocks hotlinking. `pending` (no metadata yet) renders a neutral `bg-3` disc.
 */
export const TokenImage = ({
	src,
	label,
	seed,
	size = 30,
	pending = false,
	className,
}: {
	src: string | null | undefined
	label: string
	seed?: string | null
	size?: number
	pending?: boolean
	className?: string
}) => {
	const [failed, setFailed] = useState(false)
	const style = { width: size, height: size }
	if (!isSafeUrl(src) || failed) {
		return (
			<span
				aria-hidden="true"
				className={cx(
					'flex shrink-0 items-center justify-center rounded-full font-mono font-semibold',
					pending ? 'bg-bg-3 text-ink-3' : 'text-avatar-ink',
					className,
				)}
				style={{
					...style,
					fontSize: Math.max(9, Math.round(size / 3)),
					background: pending ? undefined : `oklch(0.44 0.07 ${hashHue(seed ?? label)})`,
				}}
			>
				{initials(label)}
			</span>
		)
	}
	return (
		// biome-ignore lint/performance/noImgElement: token logos come from arbitrary hosts; next/image would need every domain allow-listed
		<img
			src={src}
			alt=""
			width={size}
			height={size}
			loading="lazy"
			referrerPolicy="no-referrer"
			onError={() => setFailed(true)}
			className={cx('shrink-0 rounded-full bg-bg-3 object-cover', className)}
			style={style}
		/>
	)
}

/* ───────────────────────────── Chip ───────────────────────────── */

export type ChipTone = 'default' | 'solid' | 'buy' | 'sell' | 'risk' | 'signal'

/**
 * Small mono tag (2px radius): launchpad, quote, BUY/SELL/NEW/GRAD/RISK tags.
 * `default` = hairline outline, `solid` = bg-3 fill; `risk`/`signal` are filled; buy/sell
 * are coloured text with an outline (pair with ▲/▼ where it carries meaning).
 */
export const Chip = ({
	children,
	tone = 'default',
	title,
	className,
}: {
	children: ReactNode
	tone?: ChipTone
	title?: string
	className?: string
}) => (
	<span
		title={title}
		className={cx(
			'inline-flex shrink-0 items-center gap-1 rounded-chip border px-1 py-px font-mono text-[9px] leading-[1.3] tracking-[0.06em] whitespace-nowrap uppercase',
			tone === 'default' && 'border-line text-ink-3',
			tone === 'solid' && 'border-bg-3 bg-bg-3 text-ink',
			tone === 'buy' && 'border-line text-buy',
			tone === 'sell' && 'border-line text-sell',
			tone === 'risk' && 'border-risk bg-risk font-semibold text-risk-ink',
			tone === 'signal' && 'border-signal bg-signal font-semibold text-signal-ink',
			className,
		)}
	>
		{children}
	</span>
)

/* ───────────────────────────── Side ───────────────────────────── */

/** Buy = blue ▲, sell = orange ▼. `children` (amount/count) follows the glyph. */
export const Side = ({
	side,
	children,
	label = false,
	className,
}: {
	side: 'buy' | 'sell'
	children?: ReactNode
	/** Also print the word ("▲ buy"). */
	label?: boolean
	className?: string
}) => (
	<span
		className={cx('num whitespace-nowrap', side === 'buy' ? 'text-buy' : 'text-sell', className)}
	>
		<span aria-hidden="true">{side === 'buy' ? '▲' : '▼'}</span>
		{label && <span> {side}</span>}
		{!label && <span className="sr-only">{side === 'buy' ? 'buys' : 'sells'} </span>}
		{children}
	</span>
)

/** `▲87 ▼69` pair used in rows and stats. */
export const BuySell = ({
	buys,
	sells,
	className,
}: {
	buys: ReactNode
	sells: ReactNode
	className?: string
}) => (
	<span className={cx('inline-flex gap-2', className)}>
		<Side side="buy">{buys}</Side>
		<Side side="sell">{sells}</Side>
	</span>
)

/* ───────────────────────────── Stat / ticker ───────────────────────────── */

const STAT_SIZE = {
	hero: 'text-[clamp(26px,4vw,58px)]',
	pool: 'text-[clamp(26px,2.6vw,36px)]',
	compact: 'text-[26px]',
} as const

/**
 * Label + big display number + hint. No card: hairline top rule, soft bottom rule.
 * When `value` changes the number rolls in (`animate-tick`, 380 ms) tinted amber (ink for
 * signal stats). `trend` adds a ▲/▼ to the hint. Throttle values to 1 s upstream
 * (`useThrottledValue`) so stats tick at most once a second.
 */
export const Stat = ({
	label,
	value,
	hint,
	trend,
	tone = 'default',
	size = 'hero',
	tickKey,
	className,
}: {
	label: ReactNode
	/** Pre-formatted value; null/undefined renders an em dash. */
	value: ReactNode
	hint?: ReactNode
	trend?: 'up' | 'down' | null
	/** `signal` for graduation stats, `risk` for risk numbers. */
	tone?: 'default' | 'signal' | 'risk'
	size?: keyof typeof STAT_SIZE
	/** Identity used to detect a change (defaults to `value` when it is a string/number). */
	tickKey?: string | number
	className?: string
}) => {
	const key = tickKey ?? (typeof value === 'string' || typeof value === 'number' ? value : null)
	const { tick } = useChangeTick(key)
	return (
		<div
			className={cx(
				'flex min-w-0 flex-col gap-1.5 border-t border-line border-b border-b-line-soft pt-4 pr-3 pb-[18px]',
				className,
			)}
		>
			<Label tone={tone === 'signal' ? 'signal' : tone === 'risk' ? 'risk' : 'default'}>
				{label}
			</Label>
			<span className="block overflow-hidden">
				<span
					key={tick}
					className={cx(
						'block font-display leading-none font-bold tabular-nums',
						STAT_SIZE[size],
						tick > 0 && 'animate-tick',
						tone === 'signal' && 'text-signal',
						tone === 'risk' && 'text-risk',
					)}
					style={tone === 'signal' ? { ['--tick-color' as string]: 'var(--color-ink)' } : undefined}
				>
					{value ?? '—'}
				</span>
			</span>
			{(hint || trend) && (
				<span className="flex items-center gap-1.5 font-mono text-[10px] text-ink-3">
					{trend && <Side side={trend === 'up' ? 'buy' : 'sell'} />}
					{hint}
				</span>
			)}
		</div>
	)
}

/* ───────────────────────────── Curve progress ───────────────────────────── */

const CURVE_PATH = 'M1 20 C 30 20, 52 15, 71 2'
const curvePoint = (t: number) => {
	const u = 1 - t
	const a = u * u * u
	const b = 3 * u * u * t
	const c = 3 * u * t * t
	const d = t * t * t
	return [a * 1 + b * 30 + c * 52 + d * 71, a * 20 + b * 20 + c * 15 + d * 2] as const
}

/**
 * Mini bonding curve: track in `line`, filled portion up to `value`, head dot on the curve,
 * terminal ring at the end (filled when graduated). ink-2 below 80 %, amber at >= 80 % or
 * graduated. Width 72 in rows, 40 on mobile. Replaces the old ProgressBar.
 */
export const CurveProgress = ({
	value,
	graduated = false,
	width = 72,
	showPct = true,
	className,
}: {
	/** Curve progress 0..1 (null = unknown). */
	value: number | null | undefined
	graduated?: boolean
	width?: number
	showPct?: boolean
	className?: string
}) => {
	const t = graduated ? 1 : Math.min(1, Math.max(0, value ?? 0))
	const hot = graduated || t >= 0.8
	const [dx, dy] = curvePoint(t)
	const tone = hot ? 'text-signal' : 'text-ink-2'
	const label = graduated ? 'graduated' : progressPct(value)
	return (
		<span
			className={cx('inline-flex items-center gap-2', className)}
			role="img"
			aria-label={`Curve ${label}`}
		>
			<svg
				width={width}
				height={(width * 22) / 72}
				viewBox="0 0 72 22"
				className={cx('shrink-0 overflow-visible', tone)}
				aria-hidden="true"
			>
				<path d={CURVE_PATH} fill="none" strokeWidth="1.5" className="stroke-line" />
				<path
					d={CURVE_PATH}
					fill="none"
					pathLength={100}
					strokeDasharray={`${Math.max(t * 100, 0.01).toFixed(2)} 100`}
					strokeWidth="2.2"
					strokeLinecap="round"
					stroke="currentColor"
					className="transition-[stroke-dasharray] duration-600 ease-out"
				/>
				<circle
					cx="71"
					cy="2"
					r="2.2"
					strokeWidth="1"
					className={cx('stroke-signal', graduated ? 'fill-signal' : 'fill-none')}
				/>
				{!graduated && <circle cx={dx} cy={dy} r="2.6" fill="currentColor" />}
			</svg>
			{showPct && (
				<span className={cx('num text-data', tone, graduated && 'text-[10.5px]')}>
					{value == null && !graduated ? '—' : label}
				</span>
			)}
		</span>
	)
}

/** @deprecated Use CurveProgress. Kept so older call sites compile. */
export const ProgressBar = CurveProgress

/* ───────────────────────────── Risk ───────────────────────────── */

export const FLAG_LABEL: Record<RiskFlag, string> = {
	creator_sold: 'creator sold',
	whale_buyer: 'whale buyer',
	wash_trading: 'wash trading',
	dumping: 'dumping',
	concentrated: 'top 10 > 50%',
	fresh_wallets: 'fresh wallets',
}

/** Row abbreviations. */
export const FLAG_SHORT: Record<RiskFlag, string> = {
	creator_sold: 'CRTR SOLD',
	whale_buyer: 'WHALE',
	wash_trading: 'WASH',
	dumping: 'DUMP',
	concentrated: 'TOP10',
	fresh_wallets: 'FRESH',
}

/** Score weights (mirror of the indexer's metrics). */
export const FLAG_WEIGHT: Record<RiskFlag, number> = {
	creator_sold: 40,
	whale_buyer: 25,
	concentrated: 25,
	wash_trading: 20,
	dumping: 15,
	fresh_wallets: 15,
}

export const FLAG_HINT: Record<RiskFlag, string> = {
	creator_sold: 'The pool creator sold into the curve',
	whale_buyer: 'Top buyer holds more than 40% of buy volume',
	wash_trading: 'Few wallets trading back and forth',
	dumping: 'Sells in the last 5m exceed 1.5× buys',
	concentrated: 'Top 10 holders own more than 50% (curve and DAMM vaults excluded)',
	fresh_wallets: 'Five or more freshly created wallets in the top 20',
}

export const RISK_HIGH = 40

const riskGlyph = (score: number) => (score >= RISK_HIGH ? '◆' : score > 0 ? '◇' : '○')
const flagTitle = (flags: RiskFlag[]) =>
	flags.length ? flags.map((f) => `${FLAG_LABEL[f]} (+${FLAG_WEIGHT[f]})`).join(', ') : 'no flags'

/**
 * Risk score with glyph. Tiers: 0 ○ (line / ink-3), 1–39 ◇ (ink-3 / ink), ≥ 40 ◆ filled risk.
 * `row`: min-w 46, mono 12/600. `header`: 92×80 block, "RISK" label, Big Shoulders 800/44.
 */
export const RiskBadge = ({
	score,
	flags = [],
	size = 'row',
	className,
}: {
	score: number
	flags?: RiskFlag[]
	size?: 'row' | 'header'
	className?: string
}) => {
	const high = score >= RISK_HIGH
	const tone = high
		? 'border-risk bg-risk text-risk-ink'
		: score > 0
			? 'border-ink-3 text-ink'
			: 'border-line text-ink-3'
	const glyph = riskGlyph(score)
	if (size === 'header') {
		return (
			<span
				title={flagTitle(flags)}
				className={cx(
					'inline-flex h-20 min-w-[92px] flex-col items-center justify-center border-[1.5px] px-2',
					tone,
					className,
				)}
			>
				<span className="font-mono text-label tracking-label">RISK</span>
				<span className="font-display text-[44px] leading-none font-extrabold tabular-nums">
					{glyph} {score}
				</span>
			</span>
		)
	}
	return (
		<span
			title={flagTitle(flags)}
			className={cx(
				'num inline-flex min-w-[46px] shrink-0 items-center justify-center gap-1 border px-1.5 py-0.5 text-data font-semibold',
				tone,
				className,
			)}
		>
			<span aria-hidden="true">{glyph}</span>
			<span className="sr-only">risk </span>
			{score}
		</span>
	)
}

/** Row flag abbreviations: max 2 + "+n", mono 9; red when the creator sold. */
export const RiskFlagsInline = ({ flags, className }: { flags: RiskFlag[]; className?: string }) =>
	flags.length === 0 ? null : (
		<span
			title={flagTitle(flags)}
			className={cx(
				'truncate font-mono text-[9px] tracking-[0.05em]',
				flags.includes('creator_sold') ? 'text-risk' : 'text-ink-3',
				className,
			)}
		>
			{flags
				.slice(0, 2)
				.map((f) => FLAG_SHORT[f])
				.join(' · ')}
			{flags.length > 2 && ` +${flags.length - 2}`}
		</span>
	)

/** Pool-row risk cell: abbreviations + badge, right aligned. */
export const RiskCell = ({ score, flags }: { score: number; flags: RiskFlag[] }) => (
	<span className="flex min-w-0 items-center justify-end gap-[7px]">
		<RiskFlagsInline flags={flags} />
		<RiskBadge score={score} flags={flags} />
	</span>
)

/** Flag chips with weights; `creator_sold` is filled red. */
export const RiskFlags = ({ flags, className }: { flags: RiskFlag[]; className?: string }) =>
	flags.length === 0 ? (
		<span className={cx('font-mono text-data-s text-ink-3', className)}>
			○ No risk flags detected from flow
		</span>
	) : (
		<ul className={cx('flex flex-wrap gap-1.5', className)}>
			{flags.map((flag) => (
				<li
					key={flag}
					title={FLAG_HINT[flag]}
					className={cx(
						'border px-[7px] py-[3px] font-mono text-[10.5px]',
						flag === 'creator_sold'
							? 'border-risk bg-risk text-risk-ink'
							: 'border-line text-ink-2',
					)}
				>
					{flag === 'creator_sold' && <span aria-hidden="true">◆ </span>}
					{FLAG_LABEL[flag]} +{FLAG_WEIGHT[flag]}
				</li>
			))}
		</ul>
	)

/** Hatched meter: one segment per active flag, width = weight %, capped at 100. */
export const RiskMeter = ({
	flags,
	raised = false,
	className,
}: {
	flags: RiskFlag[]
	/** Play the stepped alarm blink (a flag was just raised). */
	raised?: boolean
	className?: string
}) => {
	let left = 100
	const segments = flags.map((flag) => {
		const width = Math.min(FLAG_WEIGHT[flag], left)
		left -= width
		return { flag, width }
	})
	const total = 100 - left
	return (
		<div
			role="meter"
			aria-label="Risk score"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={total}
			className={cx('flex h-3.5 border border-line', className)}
		>
			{segments
				.filter((s) => s.width > 0)
				.map((s, i, list) => (
					<div
						key={s.flag}
						title={`${FLAG_LABEL[s.flag]} +${FLAG_WEIGHT[s.flag]}`}
						className={cx(
							'hatch-risk',
							i < list.length - 1 && 'border-r-2 border-bg',
							raised && 'animate-alarm',
						)}
						style={{ width: `${s.width}%` }}
					/>
				))}
		</div>
	)
}

/* ───────────────────────────── Controls ───────────────────────────── */

export type TabItem<T extends string> = {
	id: T
	label: ReactNode
	/** Shorter label under 640px (e.g. "Near grad"). */
	shortLabel?: ReactNode
	count?: ReactNode
	hint?: string
}

/**
 * Display-font tabs (Radar spec): 21px caps, mono count, 2px amber underline on the active tab.
 * Arrow keys move between tabs. Render the panel with `id={`${idPrefix}-panel`}`.
 */
export const Tabs = <T extends string>({
	items,
	value,
	onChange,
	label,
	idPrefix = 'tabs',
	className,
}: {
	items: TabItem<T>[]
	value: T
	onChange: (id: T) => void
	/** Accessible name of the tab list. */
	label: string
	idPrefix?: string
	className?: string
}) => {
	const refs = useRef<(HTMLButtonElement | null)[]>([])
	const onKeyDown = (event: KeyboardEvent, index: number) => {
		const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
		if (!delta) return
		event.preventDefault()
		const next = (index + delta + items.length) % items.length
		refs.current[next]?.focus()
		onChange(items[next].id)
	}
	return (
		<div
			role="tablist"
			aria-label={label}
			className={cx('flex flex-wrap gap-x-4 sm:gap-x-7', className)}
		>
			{items.map((item, index) => {
				const active = item.id === value
				return (
					<button
						key={item.id}
						ref={(el) => {
							refs.current[index] = el
						}}
						type="button"
						role="tab"
						id={`${idPrefix}-${item.id}`}
						aria-selected={active}
						aria-controls={`${idPrefix}-panel`}
						tabIndex={active ? 0 : -1}
						title={item.hint}
						onClick={() => onChange(item.id)}
						onKeyDown={(e) => onKeyDown(e, index)}
						className={cx(
							'flex items-baseline gap-2 border-b-2 pt-4 pb-[11px] font-display text-[15px] font-bold tracking-[0.03em] uppercase transition-colors sm:text-section',
							active ? 'border-signal text-ink' : 'border-transparent text-ink-3 hover:text-ink-2',
						)}
					>
						{item.shortLabel ? (
							<>
								<span className="sm:hidden">{item.shortLabel}</span>
								<span className="hidden sm:inline">{item.label}</span>
							</>
						) : (
							item.label
						)}
						{item.count != null && item.count !== '' && (
							<span className="font-mono text-data-s font-normal tracking-normal text-ink-3">
								{item.count}
							</span>
						)}
					</button>
				)
			})}
		</div>
	)
}

/** Segmented filter (mono 11): 9px label, hairline group, active option inverted (ink on bg). */
export const Filter = <T extends string>({
	label,
	options,
	value,
	onChange,
	className,
}: {
	label: string
	options: { value: T; label: ReactNode }[]
	value: T
	onChange: (value: T) => void
	className?: string
}) => (
	<div className={cx('flex items-center gap-2 font-mono text-data-s', className)}>
		<span className="text-[9px] tracking-label text-ink-3 uppercase" aria-hidden="true">
			{label}
		</span>
		<fieldset className="flex border border-line" aria-label={label}>
			{options.map((option) => {
				const active = option.value === value
				return (
					<button
						key={option.value}
						type="button"
						aria-pressed={active}
						onClick={() => onChange(option.value)}
						className={cx(
							'px-2 py-[5px] transition-colors',
							active ? 'bg-ink text-bg' : 'text-ink-2 hover:bg-bg-2 hover:text-ink',
						)}
					>
						{option.label}
					</button>
				)
			})}
		</fieldset>
	</div>
)

/** Square checkbox toggle ("Hide risk ≥ 40"). */
export const Checkbox = ({
	checked,
	onChange,
	children,
	className,
}: {
	checked: boolean
	onChange: (checked: boolean) => void
	children: ReactNode
	className?: string
}) => (
	<button
		type="button"
		role="checkbox"
		aria-checked={checked}
		onClick={() => onChange(!checked)}
		className={cx(
			'flex items-center gap-[7px] px-0.5 py-[5px] font-mono text-data-s text-ink-2 hover:text-ink',
			className,
		)}
	>
		<span
			aria-hidden="true"
			className={cx('size-3 border', checked ? 'border-ink bg-ink' : 'border-ink-3')}
		/>
		{children}
	</button>
)

/** 34×18 square switch (alert rules). */
export const Switch = ({
	checked,
	onChange,
	label,
	className,
}: {
	checked: boolean
	onChange: (checked: boolean) => void
	label: string
	className?: string
}) => (
	<button
		type="button"
		role="switch"
		aria-checked={checked}
		aria-label={label}
		onClick={() => onChange(!checked)}
		className={cx(
			'relative h-[18px] w-[34px] shrink-0 border-[1.5px] transition-colors',
			checked ? 'border-ink bg-ink' : 'border-line',
			className,
		)}
	>
		<span
			aria-hidden="true"
			className={cx(
				'absolute top-[2px] size-[11px] transition-[left] duration-200 ease-out',
				checked ? 'left-[18px] bg-bg' : 'left-[2px] bg-ink-3',
			)}
		/>
	</button>
)

/* ───────────────────────────── Live status ───────────────────────────── */

export type LiveStatus = 'live' | 'offline' | 'connecting'

/**
 * Live dot (circle). `live`: amber with a halo that grows with `intensity` (0..1, events in
 * the last second); `offline`: hollow orange ring; `connecting`: hollow ink-3 ring.
 */
export const LiveDot = ({
	status,
	intensity = 0,
	size = 9,
	className,
}: {
	status: LiveStatus
	intensity?: number
	size?: number
	className?: string
}) => {
	const reduced = useReducedMotion()
	const k = Math.min(1, Math.max(0, intensity))
	if (status !== 'live') {
		return (
			<span
				aria-hidden="true"
				className={cx(
					'inline-block shrink-0 rounded-full border-2',
					status === 'offline' ? 'border-sell' : 'border-ink-3',
					className,
				)}
				style={{ width: size, height: size }}
			/>
		)
	}
	return (
		<span
			aria-hidden="true"
			className={cx(
				'inline-block shrink-0 rounded-full bg-signal transition-[box-shadow,transform] duration-300 ease-out',
				className,
			)}
			style={{
				width: size,
				height: size,
				transform: reduced ? undefined : `scale(${1 + k * 0.5})`,
				boxShadow: `0 0 0 ${(2 + k * 5).toFixed(1)}px color-mix(in oklch, var(--color-signal) ${Math.round((0.12 + k * 0.2) * 100)}%, transparent)`,
			}}
		/>
	)
}

const StatusField = ({ label, children }: { label: string; children: ReactNode }) => (
	<span className="flex flex-col gap-px">
		<span className="text-[9px] tracking-label text-ink-3 uppercase">{label}</span>
		<span>{children}</span>
	</span>
)

/**
 * Stream status for the header. `full`: dot + LIVE/OFFLINE, src, ev/min, last, reconn.
 * `compact` (mobile): dot + LIVE + "312/min".
 */
export const StreamStatus = ({
	connected,
	source,
	eventsPerMinute,
	lastEventAgeMs,
	reconnects,
	intensity,
	variant = 'full',
	className,
}: {
	connected: boolean
	source?: string | null
	eventsPerMinute: number
	lastEventAgeMs: number | null | undefined
	reconnects?: number | null
	/** 0..1, drives the live dot halo. */
	intensity?: number
	variant?: 'full' | 'compact'
	className?: string
}) => {
	const status: LiveStatus = connected ? 'live' : 'offline'
	const word = (
		<span
			className={cx('font-semibold tracking-[0.08em]', connected ? 'text-signal' : 'text-sell')}
		>
			{connected ? 'LIVE' : 'OFFLINE'}
		</span>
	)
	if (variant === 'compact') {
		return (
			<span role="status" className={cx('num flex items-center gap-[7px] text-data-s', className)}>
				<LiveDot status={status} size={8} intensity={intensity} />
				{word}
				<span className="text-ink-3">{eventsPerMinute}/min</span>
			</span>
		)
	}
	return (
		<div
			role="status"
			className={cx('num flex items-center gap-[22px] text-[11.5px] whitespace-nowrap', className)}
		>
			<span className="flex items-center gap-2">
				<LiveDot status={status} intensity={intensity} />
				{word}
			</span>
			<StatusField label="src">{source ?? '—'}</StatusField>
			<StatusField label="ev/min">{eventsPerMinute}</StatusField>
			<span className="min-w-10">
				<StatusField label="last">{seconds(lastEventAgeMs)}</StatusField>
			</span>
			{reconnects != null && <StatusField label="reconn.">{reconnects}</StatusField>}
		</div>
	)
}

type BeatEvent = { t: number; kind: 'buy' | 'sell' | 'new' | 'grad'; usd: number }

/**
 * Oscilloscope trace of the last 8 s of events (150×30): buys spike up in blue, sells down in
 * orange (height ~ log USD), launches are ink dots, graduations amber. Drawn on a canvas
 * from a ref, never through React state. Calls `onIntensity` (0..1) ~4×/s for the live dot.
 */
export const Heartbeat = ({
	subscribe,
	onIntensity,
	width = 150,
	height = 30,
	className,
}: {
	subscribe: (listener: LiveListener) => () => void
	onIntensity?: (k: number) => void
	width?: number
	height?: number
	className?: string
}) => {
	const canvasRef = useRef<HTMLCanvasElement>(null)
	const onIntensityRef = useRef(onIntensity)
	onIntensityRef.current = onIntensity

	useEffect(() => {
		const events: BeatEvent[] = []
		const unsubscribe = subscribe((e) => {
			if (e.type === 'trade') events.push({ t: Date.now(), kind: e.side, usd: e.usdAmount ?? 1 })
			else if (e.type === 'pool_created') events.push({ t: Date.now(), kind: 'new', usd: 0 })
			else if (e.type === 'graduated') events.push({ t: Date.now(), kind: 'grad', usd: 0 })
			if (events.length > 600) events.splice(0, events.length - 600)
		})
		const canvas = canvasRef.current
		const ctx = canvas?.getContext('2d')
		if (!canvas || !ctx) return unsubscribe
		const dpr = window.devicePixelRatio || 1
		canvas.width = width * dpr
		canvas.height = height * dpr
		ctx.scale(dpr, dpr)
		const css = getComputedStyle(document.documentElement)
		const color = (name: string) => css.getPropertyValue(name).trim()
		const C = {
			line: color('--color-line'),
			buy: color('--color-buy'),
			sell: color('--color-sell'),
			ink: color('--color-ink'),
			signal: color('--color-signal'),
		}
		const span = 8000
		const mid = height / 2
		let breath = 0
		let lastReport = 0
		let frame = 0
		const draw = (ts: number) => {
			const now = Date.now()
			ctx.clearRect(0, 0, width, height)
			ctx.globalAlpha = 0.5
			ctx.strokeStyle = C.line
			ctx.lineWidth = 1
			ctx.beginPath()
			ctx.moveTo(0, mid)
			ctx.lineTo(width, mid)
			ctx.stroke()
			let recent = 0
			for (let i = events.length - 1; i >= 0; i--) {
				const e = events[i]
				const age = now - e.t
				if (age > span) break
				if (age < 1000) recent++
				const x = width - (age / span) * width
				ctx.globalAlpha = 0.25 + 0.75 * (1 - age / span)
				if (e.kind === 'new' || e.kind === 'grad') {
					ctx.fillStyle = e.kind === 'grad' ? C.signal : C.ink
					ctx.fillRect(x - 1.5, mid - 1.5, 3, 3)
					continue
				}
				const h = Math.min(mid - 1, 2 + Math.log10(1 + e.usd) * 4.5)
				ctx.strokeStyle = e.kind === 'buy' ? C.buy : C.sell
				ctx.lineWidth = 1.2
				ctx.beginPath()
				ctx.moveTo(x, mid)
				ctx.lineTo(x, e.kind === 'buy' ? mid - h : mid + h)
				ctx.stroke()
			}
			ctx.globalAlpha = 1
			breath = breath * 0.92 + recent * 0.08
			if (ts - lastReport > 250) {
				lastReport = ts
				onIntensityRef.current?.(Math.min(1, breath / 12))
			}
			frame = requestAnimationFrame(draw)
		}
		frame = requestAnimationFrame(draw)
		return () => {
			cancelAnimationFrame(frame)
			unsubscribe()
		}
	}, [subscribe, width, height])

	return (
		<canvas
			ref={canvasRef}
			title="Every spike is one on-chain event: buys up, sells down, launches as dots"
			className={cx('block', className)}
			style={{ width, height }}
			aria-hidden="true"
		/>
	)
}

/* ───────────────────────────── States ───────────────────────────── */

/** Static scope used by empty states: range rings, amber graduation ring, rotating sweep. */
export const ScopeGlyph = ({ size = 320, className }: { size?: number; className?: string }) => (
	<div
		className={cx('relative aspect-square shrink-0', className)}
		style={{ width: size, maxWidth: '100%' }}
		aria-hidden="true"
	>
		<div
			className="absolute inset-[6%] animate-sweep rounded-full"
			style={{
				background:
					'conic-gradient(from 0deg, transparent 0deg 300deg, color-mix(in oklch, var(--color-signal) 30%, transparent) 360deg)',
				['--sweep-period' as string]: '6s',
			}}
		/>
		<svg viewBox="0 0 100 100" className="absolute inset-0 size-full">
			{[0.25, 0.5, 0.75].map((r) => (
				<circle
					key={r}
					cx="50"
					cy="50"
					r={44 * r}
					fill="none"
					strokeWidth="0.4"
					className="stroke-line"
				/>
			))}
			<circle cx="50" cy="50" r="44" fill="none" strokeWidth="0.6" className="stroke-signal" />
			{Array.from({ length: 60 }, (_, i) => {
				const a = (i / 60) * Math.PI * 2
				const inner = i % 5 === 0 ? 45.5 : 46.5
				return (
					<line
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed tick marks
						key={i}
						x1={50 + Math.sin(a) * inner}
						y1={50 - Math.cos(a) * inner}
						x2={50 + Math.sin(a) * 48}
						y2={50 - Math.cos(a) * 48}
						strokeWidth="0.35"
						className="stroke-line"
					/>
				)
			})}
			<line x1="50" y1="50" x2="50" y2="6" strokeWidth="0.4" className="stroke-line" />
		</svg>
	</div>
)

/** Connected, no events yet: "LISTENING…" next to an idle scope. */
export const EmptyState = ({
	title = 'Listening…',
	children = 'Connected to Solami Yellowstone gRPC. The first DBC event will appear on the scope the moment it lands.',
	meta,
	scope = true,
	className,
}: {
	title?: ReactNode
	children?: ReactNode
	/** Mono footnote, e.g. "0 events · connected 12s · src grpc". */
	meta?: ReactNode
	scope?: boolean
	className?: string
}) => (
	<div
		className={cx(
			'grid items-center gap-6 px-4 py-8 sm:grid-cols-[minmax(0,320px)_1fr] sm:px-8',
			className,
		)}
	>
		{scope && <ScopeGlyph size={320} className="mx-auto w-full max-w-[260px] sm:max-w-none" />}
		<div className="flex flex-col gap-3">
			<span className="font-display text-[44px] leading-[0.9] font-extrabold tracking-[0.04em] uppercase">
				{title}
			</span>
			<span className="max-w-[48ch] text-body leading-normal text-ink-2">{children}</span>
			{meta && <span className="font-mono text-data-s text-ink-3">{meta}</span>}
		</div>
	</div>
)

/** Inline empty line for tables and feeds ("Listening… no pools match these filters yet."). */
export const EmptyRow = ({ children, className }: { children: ReactNode; className?: string }) => (
	<p className={cx('px-3 py-10 font-mono text-data text-ink-3', className)}>{children}</p>
)

const SkeletonCurve = () => (
	<svg width="72" height="22" viewBox="0 0 72 22" aria-hidden="true">
		<path
			d={CURVE_PATH}
			fill="none"
			strokeWidth="1.5"
			strokeDasharray="2 3"
			className="stroke-line"
		/>
	</svg>
)

/**
 * First-snapshot skeleton rows. Static on purpose: motion in DBC Radar always means data, so
 * nothing shimmers while we wait.
 */
export const LoadingRows = ({
	rows = 4,
	label = 'loading pools from indexer…',
	className,
}: {
	rows?: number
	label?: ReactNode
	className?: string
}) => {
	const widths = ['80%', '60%', '70%', '50%', '65%', '55%']
	return (
		<div className={className} role="status" aria-live="polite">
			<span className="sr-only">Loading</span>
			{label && <p className="py-2 text-right font-mono text-data-s text-ink-3">{label}</p>}
			{Array.from({ length: rows }, (_, i) => (
				<div
					// biome-ignore lint/suspicious/noArrayIndexKey: static placeholders
					key={i}
					className="grid h-[54px] grid-cols-[30px_minmax(0,140px)_60px_1fr_60px] items-center gap-3.5 border-b border-line-soft px-3 sm:grid-cols-[30px_140px_60px_100px_1fr_60px]"
					style={{ opacity: Math.max(0.3, 1 - i * 0.22) }}
					aria-hidden="true"
				>
					<span className="size-[30px] rounded-full bg-bg-3" />
					<span className="h-2.5 bg-bg-3" style={{ width: widths[i % widths.length] }} />
					<span className="h-2 bg-bg-3" />
					<span className="hidden h-2 bg-bg-3 sm:block" />
					<SkeletonCurve />
					<span className="h-4 border border-line" />
				</div>
			))}
		</div>
	)
}

/**
 * Indexer offline banner: hollow orange dot + OFFLINE status line, hatched "SIGNAL LOST" bar
 * with retry info and an optional RETRY NOW, and a note that numbers are frozen.
 * Dim the stale content below with `opacity-50 grayscale`.
 */
export const OfflineBanner = ({
	lastEventAgeMs,
	reconnects,
	retryInSec,
	attempt,
	snapshotAt,
	onRetry,
	className,
}: {
	lastEventAgeMs?: number | null
	reconnects?: number | null
	retryInSec?: number | null
	attempt?: number | null
	/** Pre-formatted time of the last good snapshot ("02:31:07"). */
	snapshotAt?: string | null
	onRetry?: () => void
	className?: string
}) => (
	<div role="alert" className={cx('border-b border-line', className)}>
		<div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 border-b border-line-soft px-4 py-3 font-mono text-data-s sm:px-6">
			<LiveDot status="offline" />
			<span className="font-semibold tracking-[0.08em] text-sell">OFFLINE</span>
			{lastEventAgeMs != null && (
				<span className="text-ink-3">last event {seconds(lastEventAgeMs)} ago</span>
			)}
			{reconnects != null && <span className="text-ink-3">reconnects {reconnects}</span>}
		</div>
		<div className="hatch-sell flex flex-wrap items-center gap-x-[18px] gap-y-2 px-4 py-3.5 font-mono text-data sm:px-6">
			<span className="font-display text-[22px] leading-none font-extrabold tracking-[0.06em] text-sell">
				SIGNAL LOST
			</span>
			<span className="text-ink">
				Indexer unreachable
				{retryInSec != null && ` · retrying in ${retryInSec}s`}
				{attempt != null && ` (attempt ${attempt})`}
			</span>
			{onRetry && (
				<Button size="sm" onClick={onRetry} className="ml-auto">
					Retry now
				</Button>
			)}
		</div>
		<p className="px-4 pt-3 pb-1.5 font-mono text-[10.5px] text-ink-3 sm:px-6">
			{snapshotAt ? `Showing last snapshot from ${snapshotAt} · ` : ''}numbers are frozen, not live
		</p>
	</div>
)

/** Pool not found: path, "NO BLIP", explanation, back + Solscan actions. */
export const NotFoundState = ({
	path,
	solscanHref,
	title = 'No blip',
	children = "This address isn't a Meteora DBC pool, or the radar hasn't seen it since it started listening.",
	className,
}: {
	/** Shown above the title, e.g. "/dbc-radar/pool/9xQe…V3kP". */
	path?: string
	solscanHref?: string
	title?: ReactNode
	children?: ReactNode
	className?: string
}) => (
	<div className={cx('flex flex-col justify-center gap-4 px-4 py-16 sm:px-12', className)}>
		{path && (
			<span className="font-mono text-data-s tracking-[0.12em] break-all text-ink-3">{path}</span>
		)}
		<h1 className="font-display text-[clamp(64px,12vw,88px)] leading-[0.85] font-extrabold tracking-[0.02em] uppercase">
			{title}
		</h1>
		<p className="max-w-[48ch] text-[15px] leading-normal text-ink-2">{children}</p>
		<div className="flex flex-wrap gap-2.5">
			<ButtonLink href="/" variant="solid">
				← Back to radar
			</ButtonLink>
			{solscanHref && <ButtonLink href={solscanHref}>Open on Solscan ↗</ButtonLink>}
		</div>
	</div>
)
