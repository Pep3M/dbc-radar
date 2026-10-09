'use client'

import { useSyncExternalStore } from 'react'

/**
 * Per-visitor alert preferences, kept in localStorage (every access wrapped: private windows
 * and blocked storage just fall back to the defaults). Toasts default on, browser
 * notifications default off and only turn on after the visitor grants permission.
 */
export type AlertPrefs = { toasts: boolean; browser: boolean }

const KEY = 'dbc-radar:alert-prefs'
const DEFAULTS: AlertPrefs = { toasts: true, browser: false }

let current: AlertPrefs | null = null
const listeners = new Set<() => void>()

const read = (): AlertPrefs => {
	if (current) return current
	try {
		const raw = localStorage.getItem(KEY)
		const parsed = raw ? (JSON.parse(raw) as Partial<AlertPrefs>) : {}
		current = {
			toasts: typeof parsed.toasts === 'boolean' ? parsed.toasts : DEFAULTS.toasts,
			browser: typeof parsed.browser === 'boolean' ? parsed.browser : DEFAULTS.browser,
		}
	} catch {
		current = DEFAULTS
	}
	return current
}

const notify = () => {
	for (const listener of listeners) listener()
}

const subscribe = (listener: () => void) => {
	listeners.add(listener)
	// Keep tabs in sync when another tab changes the preference.
	const onStorage = (event: StorageEvent) => {
		if (event.key !== KEY) return
		current = null
		notify()
	}
	window.addEventListener('storage', onStorage)
	return () => {
		listeners.delete(listener)
		window.removeEventListener('storage', onStorage)
	}
}

export const getAlertPrefs = read

export const setAlertPrefs = (patch: Partial<AlertPrefs>) => {
	current = { ...read(), ...patch }
	try {
		localStorage.setItem(KEY, JSON.stringify(current))
	} catch {
		// Storage unavailable: the preference lasts for this page view only.
	}
	notify()
}

/** Server render and first hydration pass use the defaults. */
export const useAlertPrefs = () => useSyncExternalStore(subscribe, read, () => DEFAULTS)
