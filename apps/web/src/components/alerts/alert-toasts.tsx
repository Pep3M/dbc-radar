'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStream } from '@/components/stream-provider'
import { getAlertPrefs } from '@/lib/alert-prefs'
import type { AlertFired } from '@/lib/api'
import { shortAddress } from '@/lib/format'
import { useBatchedQueue, useReducedMotion } from '@/lib/hooks'
import { look } from './look'

/*
 * Global alert toasts, fed by `{ type: 'alert' }` events on the shared SSE stream. Level-2
 * elevation from the design system (bg-2, hairline, the one soft shadow, radius 0) with the
 * Alerts page tags. Max 3 stacked, newest on top; alerts arriving together collapse into
 * "+N more alerts". Each toast auto-dismisses after 6 s (paused on hover / focus). Native
 * browser notifications go out only when the tab is hidden or toasts are off, so a visitor
 * never gets the same alert twice on screen.
 */

const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ')

const MAX_STACK = 3
const DISMISS_MS = 6000
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'

type Toast =
	| { key: string; kind: 'alert'; alert: AlertFired }
	| { key: string; kind: 'more'; count: number }

/** The curve threshold isn't on the event; the detail line carries it ("crossed 80% · …"). */
const thresholdOf = (alert: AlertFired) => {
	const pct = Number(alert.detail.match(/crossed (\d+)%/)?.[1])
	return Number.isFinite(pct) ? pct / 100 : undefined
}

const nameOf = (alert: AlertFired) => alert.symbol ?? shortAddress(alert.pool)

const ToastCard = ({ toast, onDone }: { toast: Toast; onDone: (key: string) => void }) => {
	const ref = useRef<HTMLDivElement>(null)
	const bar = useRef<HTMLSpanElement>(null)
	const timer = useRef<Animation | null>(null)
	const leaving = useRef(false)
	const reduced = useReducedMotion()
	const reducedRef = useRef(reduced)
	reducedRef.current = reduced
	const l = toast.kind === 'alert' ? look(toast.alert, thresholdOf(toast.alert)) : null

	const close = useCallback(() => {
		if (leaving.current) return
		leaving.current = true
		timer.current?.cancel()
		const el = ref.current
		if (!el || reducedRef.current) return onDone(toast.key)
		el.animate(
			[
				{ opacity: 1, transform: 'none' },
				{ opacity: 0, transform: 'translateX(18px)' },
			],
			{ duration: 200, easing: EASE, fill: 'forwards' },
		).onfinish = () => onDone(toast.key)
	}, [onDone, toast.key])

	// Both deps are stable for a toast's lifetime: this runs once, on mount.
	const tintColor = l?.tint
	useEffect(() => {
		const el = ref.current
		if (el) {
			const tint = tintColor
				? `color-mix(in oklch, ${tintColor} 18%, var(--color-bg-2))`
				: 'var(--color-bg-3)'
			el.animate(
				reducedRef.current
					? [{ backgroundColor: tint }, { backgroundColor: 'var(--color-bg-2)' }]
					: [
							{ opacity: 0, transform: 'translateY(12px)', backgroundColor: tint },
							{ opacity: 1, transform: 'none', backgroundColor: 'var(--color-bg-2)' },
						],
				{ duration: reducedRef.current ? 900 : 420, easing: EASE },
			)
		}
		// The countdown bar doubles as the dismiss timer, so pausing it pauses the toast.
		const countdown = bar.current?.animate(
			[{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }],
			{
				duration: DISMISS_MS,
				easing: 'linear',
				fill: 'forwards',
			},
		)
		if (!countdown) return
		timer.current = countdown
		countdown.onfinish = close
		return () => countdown.cancel()
	}, [close, tintColor])

	const pause = () => timer.current?.pause()
	const resume = () => {
		if (!leaving.current) timer.current?.play()
	}

	return (
		<div
			ref={ref}
			onMouseEnter={pause}
			onMouseLeave={resume}
			onFocus={pause}
			onBlur={resume}
			className="pointer-events-auto relative w-full overflow-hidden border border-line bg-bg-2 shadow-float"
		>
			<div className="flex items-start gap-3 py-3 pr-2 pl-3.5">
				{toast.kind === 'alert' && l ? (
					<>
						<span
							aria-hidden="true"
							className={cx('w-4 pt-px text-center font-mono text-[13px]', l.glyphClass)}
						>
							{l.glyph}
						</span>
						<div className="flex min-w-0 flex-1 flex-col gap-1.5">
							<span
								className={cx(
									'w-max px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-[0.06em]',
									l.tagClass,
								)}
							>
								{l.tag}
							</span>
							<span className="min-w-0 truncate font-mono text-data">
								<bdi className="font-sans text-[13.5px] font-semibold text-ink">
									{nameOf(toast.alert)}
								</bdi>{' '}
								<span className="text-ink-3">{toast.alert.detail}</span>
							</span>
							<span className="flex gap-4 font-mono text-[10.5px] tracking-[0.06em] uppercase">
								<Link
									href={`/pool/${toast.alert.pool}`}
									onClick={close}
									className="text-ink underline decoration-line underline-offset-[3px] hover:text-signal"
								>
									Open pool →
								</Link>
								<Link href="/alerts" onClick={close} className="text-ink-3 hover:text-ink">
									All alerts
								</Link>
							</span>
						</div>
					</>
				) : toast.kind === 'more' ? (
					<div className="flex min-w-0 flex-1 items-baseline justify-between gap-3 py-0.5 pl-7 font-mono text-data">
						<span className="text-ink-2">
							+{toast.count} more {toast.count === 1 ? 'alert' : 'alerts'}
						</span>
						<Link
							href="/alerts"
							onClick={close}
							className="text-[10.5px] tracking-[0.06em] text-ink uppercase underline decoration-line underline-offset-[3px] hover:text-signal"
						>
							View all →
						</Link>
					</div>
				) : null}
				<button
					type="button"
					onClick={close}
					aria-label="Dismiss alert"
					className="-mt-1 flex size-7 shrink-0 items-center justify-center font-mono text-[15px] text-ink-3 hover:text-ink"
				>
					×
				</button>
			</div>
			<span
				ref={bar}
				aria-hidden="true"
				className={cx(
					'absolute inset-x-0 bottom-0 h-px origin-left bg-ink-3',
					reduced && 'opacity-0',
				)}
			/>
		</div>
	)
}

const notifyNative = (alert: AlertFired, open: (pool: string) => void) => {
	if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
	try {
		const l = look(alert, thresholdOf(alert))
		const n = new Notification(`${nameOf(alert)} · ${l.tag.toLowerCase()}`, {
			body: alert.detail,
			tag: `dbc-radar-alert-${alert.id}`,
		})
		n.onclick = () => {
			window.focus()
			open(alert.pool)
			n.close()
		}
	} catch {
		// Some mobile browsers only allow notifications from a service worker.
	}
}

export const AlertToasts = () => {
	const { subscribe } = useStream()
	const router = useRouter()
	const [stack, setStack] = useState<Toast[]>([])
	const seen = useRef(new Set<number>())

	const push = useBatchedQueue<AlertFired>((batch) => {
		const prefs = getAlertPrefs()
		const fresh = batch.filter((a) => !seen.current.has(a.id))
		for (const a of fresh) seen.current.add(a.id)
		if (fresh.length === 0) return
		fresh.sort((a, b) => b.ts - a.ts)
		if (prefs.browser && (document.hidden || !prefs.toasts)) {
			// One native notification per batch, the rest summarised in its body.
			const [first, ...rest] = fresh
			notifyNative(
				rest.length ? { ...first, detail: `${first.detail} · +${rest.length} more` } : first,
				(pool) => router.push(`/pool/${pool}`),
			)
		}
		if (!prefs.toasts) return
		const [newest, ...extra] = fresh
		setStack((prev) => {
			let more = extra.length
			let alerts: Toast[] = [{ key: `a${newest.id}`, kind: 'alert', alert: newest }]
			for (const t of prev) {
				if (t.kind === 'more') more += t.count
				else alerts.push(t)
			}
			// Overflow beyond the stack folds into the "+N more" line instead of vanishing.
			if (alerts.length + (more > 0 ? 1 : 0) > MAX_STACK) {
				more += alerts.length - (MAX_STACK - 1)
				alerts = alerts.slice(0, MAX_STACK - 1)
			}
			return more > 0 ? [...alerts, { key: `m${newest.id}`, kind: 'more', count: more }] : alerts
		})
	}, 600)

	useEffect(
		() =>
			subscribe((event) => {
				if (event.type === 'alert') push(event.alert)
			}),
		[subscribe, push],
	)

	const done = useCallback(
		(key: string) => setStack((prev) => prev.filter((t) => t.key !== key)),
		[],
	)

	return (
		<section
			aria-label="Alerts"
			role="status"
			aria-live="polite"
			className="pointer-events-none fixed right-4 bottom-[calc(72px+env(safe-area-inset-bottom))] left-4 z-40 flex flex-col items-end gap-2 sm:right-8 sm:bottom-8 sm:left-auto sm:w-[360px]"
		>
			{stack.map((toast) => (
				<ToastCard key={toast.key} toast={toast} onDone={done} />
			))}
		</section>
	)
}
