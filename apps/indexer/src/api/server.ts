import type { Alerts } from '../alerts'
import type { PoolSort } from '../domain/api'
import type { Ingestor } from '../ingest'
import type { Metrics } from '../metrics'
import { telemetry } from '../telemetry'

const SORTS = new Set<PoolSort>(['new', 'hot', 'progress'])

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
	})

const clampLimit = (value: string | null, fallback: number) =>
	Math.min(Math.max(Number(value) || fallback, 1), 200)

export const startServer = (opts: {
	port: number
	sourceName: string
	sourceStats?: Record<string, number>
	components?: Record<string, Record<string, number>>
	metrics: Metrics
	ingestor: Ingestor
	alerts: Alerts
	blurConnected: () => boolean
}) => {
	const { metrics, ingestor } = opts

	return Bun.serve({
		port: opts.port,
		idleTimeout: 0,
		routes: {
			'/api/health': () =>
				json({
					source: opts.sourceName,
					sourceStats: opts.sourceStats,
					components: opts.components,
					...ingestor.health,
					lastEventAgeMs: ingestor.health.lastEventAt
						? Date.now() - ingestor.health.lastEventAt
						: null,
					uptimeMs: Date.now() - ingestor.health.startedAt,
				}),
			'/api/stats': () => json(metrics.stats()),
			/** Clock sync for browser-side latency: browsers estimate their offset from this. */
			'/api/time': () => json({ now: Date.now() }),
			'/api/pipeline': () => json(telemetry.snapshot(opts.sourceName, opts.blurConnected())),
			'/api/alerts': () => json(opts.alerts.state()),
			'/api/pools': (req) => {
				const url = new URL(req.url)
				const sort = url.searchParams.get('sort') as PoolSort
				return json(
					metrics.listPools(
						SORTS.has(sort) ? sort : 'new',
						clampLimit(url.searchParams.get('limit'), 50),
						url.searchParams.get('onlyNew') === '1',
					),
				)
			},
			'/api/graduated': (req) =>
				json(metrics.listGraduated(clampLimit(new URL(req.url).searchParams.get('limit'), 20))),
			'/api/pools/:pool': (req) => {
				const pool = metrics.getPool(req.params.pool)
				return pool ? json(pool) : json({ error: 'not_found' }, 404)
			},
			'/api/stream': (req) => {
				let unsubscribe = () => {}
				const stream = new ReadableStream({
					start(controller) {
						const encoder = new TextEncoder()
						const send = (data: unknown) =>
							controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
						send({ type: 'hello', source: opts.sourceName })
						const off = ingestor.subscribe(send)
						telemetry.sseClients(1)
						let closed = false
						unsubscribe = () => {
							if (closed) return
							closed = true
							off()
							telemetry.sseClients(-1)
						}
						req.signal.addEventListener('abort', () => unsubscribe())
					},
					cancel() {
						unsubscribe()
					},
				})
				return new Response(stream, {
					headers: {
						'content-type': 'text/event-stream',
						'cache-control': 'no-cache, no-transform',
						'x-accel-buffering': 'no',
						connection: 'keep-alive',
						'access-control-allow-origin': '*',
					},
				})
			},
		},
		fetch: () => json({ error: 'not_found' }, 404),
	})
}
