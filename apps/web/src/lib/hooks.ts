'use client'

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { apiBase, type LiveEvent } from './api'

export const usePolling = <T>(
	fetcher: () => Promise<T>,
	intervalMs: number,
	deps: unknown[] = [],
) => {
	const [data, setData] = useState<T | null>(null)
	const [error, setError] = useState<Error | null>(null)
	const fetcherRef = useRef(fetcher)
	fetcherRef.current = fetcher

	useEffect(() => {
		let active = true
		const tick = () =>
			fetcherRef
				.current()
				.then((value) => {
					if (!active) return
					setData(value)
					setError(null)
				})
				.catch((err: Error) => active && setError(err))
		tick()
		const timer = setInterval(tick, intervalMs)
		return () => {
			active = false
			clearInterval(timer)
		}
	}, [intervalMs, ...deps])

	return { data, error }
}

export const useNow = (intervalMs = 1000) => {
	// Starts at 0 and is set after mount so the prerendered shell has no clock-dependent output.
	const [now, setNow] = useState(0)
	useEffect(() => {
		setNow(Date.now())
		const timer = setInterval(() => setNow(Date.now()), intervalMs)
		return () => clearInterval(timer)
	}, [intervalMs])
	return now
}

/** DOM flush cadence from the handoff: React-visible updates land at most 4 times a second. */
export const FLUSH_MS = 250

const reducedMotionQuery = '(prefers-reduced-motion: reduce)'
const subscribeReducedMotion = (onChange: () => void) => {
	const media = window.matchMedia(reducedMotionQuery)
	media.addEventListener('change', onChange)
	return () => media.removeEventListener('change', onChange)
}

/**
 * `true` when the user asks for reduced motion. Server render and first hydration pass
 * report `false`, so markup never depends on it before mount. Use it for JS-driven motion
 * (canvas, Web Animations); CSS `animate-*` utilities already honour the media query.
 */
export const useReducedMotion = () =>
	useSyncExternalStore(
		subscribeReducedMotion,
		() => window.matchMedia(reducedMotionQuery).matches,
		() => false,
	)

/**
 * Queue that collects items at any rate and hands them to `onFlush` in one batch every
 * `intervalMs` (4 Hz by default). Use it to turn a firehose (SSE, canvas hits) into a
 * bounded number of React updates: `onFlush` typically sorts/caps and calls one setState.
 * Returns a stable `push`.
 */
export const useBatchedQueue = <T>(onFlush: (batch: T[]) => void, intervalMs = FLUSH_MS) => {
	const queue = useRef<T[]>([])
	const onFlushRef = useRef(onFlush)
	onFlushRef.current = onFlush

	useEffect(() => {
		const timer = setInterval(() => {
			if (queue.current.length === 0) return
			const batch = queue.current
			queue.current = []
			onFlushRef.current(batch)
		}, intervalMs)
		return () => clearInterval(timer)
	}, [intervalMs])

	return useCallback((item: T) => {
		queue.current.push(item)
	}, [])
}

/**
 * Follows `value` but re-renders at most once per `intervalMs` (trailing edge, so the
 * latest value always lands). Stats use 1000 ms ("Stats tick once a second").
 */
export const useThrottledValue = <T>(value: T, intervalMs = FLUSH_MS) => {
	const [shown, setShown] = useState(value)
	const last = useRef(0)
	useEffect(() => {
		const wait = last.current + intervalMs - Date.now()
		if (wait <= 0) {
			last.current = Date.now()
			setShown(value)
			return
		}
		const timer = setTimeout(() => {
			last.current = Date.now()
			setShown(value)
		}, wait)
		return () => clearTimeout(timer)
	}, [value, intervalMs])
	return shown
}

/**
 * Returns a counter that increments each time `value` changes after mount (never on the first
 * render). Use it as a React `key` to replay a CSS animation, e.g. `animate-tick`.
 * `direction` compares numeric values: 1 up, -1 down, 0 otherwise.
 */
export const useChangeTick = (value: unknown) => {
	const [state, setState] = useState({ tick: 0, direction: 0 as -1 | 0 | 1 })
	const prev = useRef(value)
	useEffect(() => {
		if (Object.is(prev.current, value)) return
		const before = prev.current
		prev.current = value
		const direction =
			typeof before === 'number' && typeof value === 'number'
				? value > before
					? 1
					: value < before
						? -1
						: 0
				: 0
		setState((s) => ({ tick: s.tick + 1, direction }))
	}, [value])
	return state
}

export type FeedItem = LiveEvent & { id: number }
export type LiveListener = (event: LiveEvent) => void

const MAX_FEED = 60

/**
 * One SSE connection to the indexer. `items` (newest first, max 60) is flushed to React at
 * 4 Hz; `subscribe` delivers every raw event synchronously for mutable models (canvas scope,
 * heartbeat) that must not wait on React. Prefer `useStream()` from `stream-provider`,
 * which shares a single instance of this hook across the app.
 */
export const useLiveStream = () => {
	const [items, setItems] = useState<FeedItem[]>([])
	const [connected, setConnected] = useState(false)
	const [eventsPerMinute, setEventsPerMinute] = useState(0)
	const timestamps = useRef<number[]>([])
	const nextId = useRef(0)
	const listeners = useRef(new Set<LiveListener>())

	const push = useBatchedQueue<FeedItem>((batch) => {
		setItems((prev) => [...batch.reverse(), ...prev].slice(0, MAX_FEED))
	})

	const subscribe = useCallback((listener: LiveListener) => {
		listeners.current.add(listener)
		return () => {
			listeners.current.delete(listener)
		}
	}, [])

	useEffect(() => {
		const source = new EventSource(`${apiBase}/stream`)
		source.onopen = () => setConnected(true)
		source.onerror = () => setConnected(false)
		source.onmessage = (message) => {
			const event = JSON.parse(message.data) as LiveEvent | { type: 'hello' }
			// A message proves the stream is open even if an earlier error flagged it down.
			setConnected(true)
			if (event.type === 'hello') return
			timestamps.current.push(Date.now())
			for (const listener of listeners.current) listener(event)
			push({ ...event, id: nextId.current++ })
		}
		const rate = setInterval(() => {
			const cutoff = Date.now() - 60_000
			timestamps.current = timestamps.current.filter((t) => t >= cutoff)
			setEventsPerMinute(timestamps.current.length)
		}, 2000)
		return () => {
			source.close()
			clearInterval(rate)
		}
	}, [push])

	return { items, connected, eventsPerMinute, subscribe }
}
