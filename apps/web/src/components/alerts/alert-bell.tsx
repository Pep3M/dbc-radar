'use client'

import Link from 'next/link'
import { useEffect, useId, useRef, useState } from 'react'
import { Switch } from '@/components/ui'
import { setAlertPrefs, useAlertPrefs } from '@/lib/alert-prefs'
import { api } from '@/lib/api'

/*
 * Header control for the visitor's alert preferences: on-page toasts (default on) and native
 * browser notifications (default off; asks for permission only when switched on).
 */

const cx = (...classes: (string | false | null | undefined)[]) => classes.filter(Boolean).join(' ')

type Permission = NotificationPermission | 'unsupported'

const currentPermission = (): Permission =>
	typeof Notification === 'undefined' ? 'unsupported' : Notification.permission

const BellIcon = ({ muted }: { muted: boolean }) => (
	<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" className="overflow-visible">
		<path
			d="M3.5 11.5 V7 a4.5 4.5 0 0 1 9 0 V11.5 L13.5 12.5 H2.5 Z"
			fill="none"
			strokeWidth="1.4"
			strokeLinejoin="miter"
			className="stroke-current"
		/>
		<path d="M6.5 14 H9.5" strokeWidth="1.4" className="stroke-current" />
		{muted && <path d="M2 2 L14 14" strokeWidth="1.4" className="stroke-current" />}
	</svg>
)

const Row = ({
	title,
	hint,
	children,
}: {
	title: string
	hint: string
	children: React.ReactNode
}) => (
	<div className="flex items-start justify-between gap-4 border-b border-line-soft py-3">
		<div className="flex flex-col gap-0.5">
			<span className="text-[13.5px] font-semibold">{title}</span>
			<span className="font-mono text-[10.5px] leading-[1.45] whitespace-normal text-ink-3">
				{hint}
			</span>
		</div>
		{children}
	</div>
)

export const AlertBell = ({ className }: { className?: string }) => {
	const prefs = useAlertPrefs()
	const [open, setOpen] = useState(false)
	const [permission, setPermission] = useState<Permission>('default')
	const root = useRef<HTMLDivElement>(null)
	const panelId = useId()
	const [bot, setBot] = useState<string | null>(null)

	// The subscriber bot's username, fetched once the panel is first opened.
	useEffect(() => {
		if (!open || bot) return
		api
			.alerts()
			.then((state) => setBot(state.destinations.telegram.botUsername ?? null))
			.catch(() => {})
	}, [open, bot])

	useEffect(() => {
		setPermission(currentPermission())
	}, [])

	useEffect(() => {
		if (!open) return
		const onDown = (event: PointerEvent) => {
			if (!root.current?.contains(event.target as Node)) setOpen(false)
		}
		const onKey = (event: KeyboardEvent) => {
			if (event.key === 'Escape') setOpen(false)
		}
		document.addEventListener('pointerdown', onDown)
		document.addEventListener('keydown', onKey)
		return () => {
			document.removeEventListener('pointerdown', onDown)
			document.removeEventListener('keydown', onKey)
		}
	}, [open])

	const browserOn = prefs.browser && permission === 'granted'

	const toggleBrowser = async (next: boolean) => {
		if (!next) return setAlertPrefs({ browser: false })
		if (typeof Notification === 'undefined') return setPermission('unsupported')
		let result = Notification.permission
		if (result === 'default') {
			try {
				result = await Notification.requestPermission()
			} catch {
				result = Notification.permission
			}
		}
		setPermission(result)
		setAlertPrefs({ browser: result === 'granted' })
	}

	const browserHint =
		permission === 'unsupported'
			? 'Not supported in this browser.'
			: permission === 'denied'
				? 'Blocked in your browser settings for this site.'
				: 'Native notification while this tab is in the background. Click it to open the pool.'

	const muted = !prefs.toasts && !browserOn

	return (
		<div ref={root} className={cx('relative', className)}>
			<button
				type="button"
				aria-expanded={open}
				aria-controls={panelId}
				aria-label={`Alert notifications: ${muted ? 'off' : 'on'}`}
				title="Alert notifications"
				onClick={() => setOpen((o) => !o)}
				className={cx(
					'flex size-8 items-center justify-center border transition-colors',
					open ? 'border-ink text-ink' : 'border-line text-ink-2 hover:border-ink-3 hover:text-ink',
				)}
			>
				<BellIcon muted={muted} />
			</button>
			{open && (
				<div
					id={panelId}
					role="dialog"
					aria-label="Alert notifications"
					className="absolute top-[calc(100%+10px)] right-0 z-40 w-[min(320px,calc(100vw-32px))] border border-line bg-bg-2 px-4 pt-1 pb-3 whitespace-normal shadow-float"
				>
					<Row title="Toasts" hint="Pop up on any page when an alert rule fires.">
						<Switch
							checked={prefs.toasts}
							onChange={(toasts) => setAlertPrefs({ toasts })}
							label="Alert toasts"
						/>
					</Row>
					<Row title="Browser notifications" hint={browserHint}>
						<Switch
							checked={browserOn}
							onChange={(next) => void toggleBrowser(next)}
							label="Browser notifications"
							className={
								permission === 'unsupported' || permission === 'denied' ? 'opacity-40' : undefined
							}
						/>
					</Row>
					<div className="flex items-baseline justify-between gap-3 pt-3 font-mono text-[10.5px] text-ink-3">
						<span>Saved in this browser.</span>
						<span className="flex shrink-0 gap-3 whitespace-nowrap">
							{bot && (
								<a
									href={`https://t.me/${bot}`}
									target="_blank"
									rel="noopener noreferrer"
									className="tracking-[0.06em] text-ink uppercase underline decoration-line underline-offset-[3px] hover:text-signal"
								>
									Telegram →
								</a>
							)}
							<Link
								href="/alerts"
								onClick={() => setOpen(false)}
								className="tracking-[0.06em] text-ink uppercase underline decoration-line underline-offset-[3px] hover:text-signal"
							>
								Rules →
							</Link>
						</span>
					</div>
				</div>
			)}
		</div>
	)
}
