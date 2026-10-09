'use client'

import { createContext, type ReactNode, useContext } from 'react'
import { api, type Health } from '@/lib/api'
import { type FeedItem, type LiveListener, useLiveStream, usePolling } from '@/lib/hooks'

export type StreamState = {
	/** Latest live events, newest first (max 60), flushed at 4 Hz. */
	items: FeedItem[]
	/** SSE connection to the indexer is open. */
	connected: boolean
	/** Events received by this browser in the trailing 60 s. */
	eventsPerMinute: number
	/** Indexer health, polled every 5 s (null until the first response). */
	health: Health | null
	/** The health endpoint is failing: indexer unreachable. */
	healthError: Error | null
	/** Raw, unbatched events for mutable models (canvas). Returns an unsubscribe function. */
	subscribe: (listener: LiveListener) => () => void
}

const StreamContext = createContext<StreamState | null>(null)

/** Mounted once in the root layout: one EventSource and one health poll for the whole app. */
export const StreamProvider = ({ children }: { children: ReactNode }) => {
	const stream = useLiveStream()
	const { data: health, error: healthError } = usePolling(api.health, 5000)
	return (
		<StreamContext.Provider value={{ ...stream, health, healthError }}>
			{children}
		</StreamContext.Provider>
	)
}

export const useStream = () => {
	const value = useContext(StreamContext)
	if (!value) throw new Error('useStream must be used inside <StreamProvider>')
	return value
}
