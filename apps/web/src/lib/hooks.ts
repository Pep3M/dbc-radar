'use client'

import { useEffect, useRef, useState } from 'react'
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

export type FeedItem = LiveEvent & { id: number }

const MAX_FEED = 60

export const useLiveStream = () => {
	const [items, setItems] = useState<FeedItem[]>([])
	const [connected, setConnected] = useState(false)
	const [eventsPerMinute, setEventsPerMinute] = useState(0)
	const timestamps = useRef<number[]>([])
	const nextId = useRef(0)

	useEffect(() => {
		const source = new EventSource(`${apiBase}/stream`)
		source.onopen = () => setConnected(true)
		source.onerror = () => setConnected(false)
		source.onmessage = (message) => {
			const event = JSON.parse(message.data) as LiveEvent | { type: 'hello' }
			if (event.type === 'hello') return
			const now = Date.now()
			timestamps.current.push(now)
			setItems((prev) => [{ ...event, id: nextId.current++ }, ...prev].slice(0, MAX_FEED))
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
	}, [])

	return { items, connected, eventsPerMinute }
}
