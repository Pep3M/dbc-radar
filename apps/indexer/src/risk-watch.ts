import type { LiveEvent, PoolSummary, RiskFlag } from './domain/api'
import type { Metrics } from './metrics'

const TICK_MS = 15_000
const ACTIVE_MS = 10 * 60_000
const MAX_ACTIVE = 500

/**
 * Turns risk flags into `risk` live events, once per pool and flag. `creator_sold` is pushed
 * by the ingestor the moment the sell lands; the rest are diffed every few seconds over
 * recently active pools. The first pass only seeds state, so a restart doesn't replay
 * every existing flag.
 */
export const createRiskWatcher = (metrics: Metrics, publish: (event: LiveEvent) => void) => {
	const raised = new Map<string, Set<RiskFlag>>()
	let seeded = false
	let timer: ReturnType<typeof setInterval> | undefined

	const diff = (summary: PoolSummary, emit: boolean) => {
		let known = raised.get(summary.pool)
		if (!known) {
			known = new Set()
			raised.set(summary.pool, known)
		}
		for (const flag of summary.risk.flags) {
			if (known.has(flag)) continue
			known.add(flag)
			if (emit)
				publish({
					type: 'risk',
					pool: summary.pool,
					symbol: summary.symbol,
					flag,
					score: summary.risk.score,
					ts: Date.now(),
				})
		}
	}

	const tick = () => {
		try {
			for (const summary of metrics.listActive(ACTIVE_MS, MAX_ACTIVE)) diff(summary, seeded)
			seeded = true
		} catch (error) {
			console.warn('[risk] tick failed:', (error as Error).message)
		}
	}

	return {
		/** Ingest hook: called inside the write transaction, so defer to after the commit. */
		creatorSold(pool: string) {
			queueMicrotask(() => {
				const summary = metrics.getSummary(pool)
				if (summary) diff(summary, true)
			})
		},
		start() {
			tick()
			timer = setInterval(tick, TICK_MS)
		},
		stop() {
			clearInterval(timer)
		},
	}
}
