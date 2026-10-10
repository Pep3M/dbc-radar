'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { type ReactNode, useState } from 'react'
import { useHydrated } from '@/lib/hooks'
import { AlertBell } from './alerts/alert-bell'
import { AlertToasts } from './alerts/alert-toasts'
import { useStream } from './stream-provider'
import { Heartbeat, StreamStatus, Wordmark } from './ui'

/*
 * App chrome: sticky header (mark, nav, stream status slot), footer, and a bottom tab bar
 * under 640px. Page content goes between them; pages own their own max width
 * (`mx-auto max-w-[1520px] px-4 sm:px-8` matches the header gutters).
 */

type NavItem = { href: string; label: string; match: (path: string) => boolean }

const NAV: NavItem[] = [
	{ href: '/', label: 'Radar', match: (p) => p === '/' || p.startsWith('/pool') },
	{ href: '/alerts', label: 'Alerts', match: (p) => p.startsWith('/alerts') },
	{ href: '/about', label: 'Under the hood', match: (p) => p.startsWith('/about') },
]

/** Mobile tab bar. FEED jumps to the radar's `#feed` section (give the live feed that id). */
const MOBILE_NAV: NavItem[] = [
	NAV[0],
	{ href: '/#feed', label: 'Feed', match: () => false },
	NAV[1],
	{ href: '/about', label: 'Hood', match: NAV[2].match },
]

const NavDot = ({ active }: { active: boolean }) => (
	<span
		aria-hidden="true"
		className={`size-1.5 shrink-0 rounded-full ${active ? 'bg-signal' : 'bg-transparent'}`}
	/>
)

const NavLinks = ({ path }: { path: string | null }) => (
	<>
		{NAV.map((item) => {
			const active = path != null && item.match(path)
			return (
				<Link
					key={item.href}
					href={item.href}
					aria-current={active ? 'page' : undefined}
					className={`flex items-center gap-[7px] transition-colors ${active ? 'text-ink' : 'text-ink-3 hover:text-ink-2'}`}
				>
					<NavDot active={active} />
					{item.label}
				</Link>
			)
		})}
	</>
)

// usePathname suspends on routes with unknown dynamic params (cacheComponents, e.g.
// /pool/[pool]) and, even inside <Suspense>, Next 16.4 can leak an unhandled rejection
// when the prerender aborts. Read it only after mount; until then the links render
// without an active state.
const ActiveNavLinks = () => <NavLinks path={usePathname()} />

const MobileLinks = ({ path }: { path: string | null }) => (
	<>
		{MOBILE_NAV.map((item) => {
			const active = path != null && item.match(path)
			return (
				<Link
					key={item.label}
					href={item.href}
					aria-current={active ? 'page' : undefined}
					className={`flex flex-col items-center justify-center gap-1 ${active ? 'text-ink' : 'text-ink-3'}`}
				>
					<span
						aria-hidden="true"
						className={`size-[5px] rounded-full ${active ? 'bg-signal' : ''}`}
					/>
					{item.label}
				</Link>
			)
		})}
	</>
)
const ActiveMobileLinks = () => <MobileLinks path={usePathname()} />

/** Header right side: heartbeat trace + stream status (full on desktop, compact on mobile). */
export const HeaderStreamStatus = () => {
	const { connected, eventsPerMinute, health, healthError, subscribe } = useStream()
	const [intensity, setIntensity] = useState(0)
	const live = connected && !healthError
	const props = {
		connected: live,
		eventsPerMinute,
		intensity,
		source: health?.source,
		lastEventAgeMs: health?.lastEventAgeMs,
		reconnects: health?.sourceStats?.reconnects,
	}
	return (
		<>
			<div className="hidden items-center gap-[22px] lg:flex">
				<Heartbeat subscribe={subscribe} onIntensity={setIntensity} />
				<StreamStatus {...props} />
			</div>
			<StreamStatus {...props} variant="compact" className="lg:hidden" />
		</>
	)
}

export const Header = ({ status }: { status?: ReactNode }) => {
	const hydrated = useHydrated()
	return (
		<header className="sticky top-0 z-30 border-b border-line-soft bg-bg">
			<div className="flex min-h-[52px] items-center gap-x-8 gap-y-2 px-4 whitespace-nowrap sm:min-h-[60px] sm:px-8">
				<Link href="/" aria-label="DBC Radar home" className="shrink-0">
					<Wordmark size={22} className="sm:hidden" />
					<Wordmark size={28} className="hidden sm:flex" />
				</Link>
				<nav
					aria-label="Main"
					className="hidden gap-[26px] font-mono text-data-s tracking-[0.08em] uppercase sm:flex"
				>
					{hydrated ? <ActiveNavLinks /> : <NavLinks path={null} />}
				</nav>
				<div className="ml-auto flex items-center gap-3 sm:gap-5">
					{status}
					<AlertBell />
				</div>
			</div>
		</header>
	)
}

export const MobileNav = () => {
	const hydrated = useHydrated()
	return (
		<nav
			aria-label="Main"
			className="fixed inset-x-0 bottom-0 z-30 grid h-[60px] grid-cols-4 border-t border-line bg-bg pb-[env(safe-area-inset-bottom)] font-mono text-[10px] tracking-[0.06em] uppercase sm:hidden"
		>
			{hydrated ? <ActiveMobileLinks /> : <MobileLinks path={null} />}
		</nav>
	)
}

export const Footer = () => (
	<footer className="mx-auto mt-auto w-full max-w-[1520px] border-t border-line-soft px-4 pt-[18px] pb-24 font-mono text-data-s leading-[1.6] text-ink-3 sm:px-8 sm:pb-10">
		Built for Colosseum Crypto World&apos;s Fair · data via{' '}
		<a
			href="https://solami.dev"
			target="_blank"
			rel="noopener noreferrer"
			className="text-ink underline decoration-line hover:text-signal"
		>
			Solami
		</a>{' '}
		· by{' '}
		<a
			href="https://pep3marquez.com"
			className="text-ink underline decoration-line hover:text-signal"
		>
			pep3marquez
		</a>
		. Not financial advice: risk flags are heuristics over on-chain flow.
	</footer>
)

/** Full chrome around page content. */
export const Shell = ({ children, status }: { children: ReactNode; status?: ReactNode }) => (
	<>
		<a
			href="#main"
			className="sr-only z-50 bg-ink px-3 py-2 font-mono text-data-s text-bg focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
		>
			Skip to content
		</a>
		<Header status={status} />
		<main id="main" className="flex w-full flex-1 flex-col">
			{children}
		</main>
		<Footer />
		<AlertToasts />
		<MobileNav />
	</>
)
