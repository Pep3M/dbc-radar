import type {
	AlertsState,
	GlobalStats,
	Health,
	Pipeline,
	PoolDetail,
	PoolSort,
	PoolSummary,
} from '@dbc-radar/indexer/types'

export type {
	AlertDelivery,
	AlertFired,
	AlertPayload,
	AlertsState,
	AlertType,
	GlobalStats,
	Health,
	LatencySample,
	LiveEvent,
	Pipeline,
	PipelineComponent,
	PoolDetail,
	PoolSummary,
	RiskFlag,
} from '@dbc-radar/indexer/types'

export const apiBase = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/api`

const get = async <T>(path: string): Promise<T> => {
	const res = await fetch(`${apiBase}${path}`, { cache: 'no-store' })
	if (!res.ok) throw new Error(`${res.status} ${path}`)
	return res.json() as Promise<T>
}

export type Tab = PoolSort | 'graduated'

export const api = {
	pools: (tab: Tab) =>
		tab === 'graduated'
			? get<PoolSummary[]>('/graduated?limit=50')
			: get<PoolSummary[]>(`/pools?sort=${tab}&limit=50${tab === 'new' ? '&onlyNew=1' : ''}`),
	pool: (pool: string) => get<PoolDetail>(`/pools/${pool}`),
	stats: () => get<GlobalStats>('/stats'),
	health: () => get<Health>('/health'),
	alerts: () => get<AlertsState>('/alerts'),
	pipeline: () => get<Pipeline>('/pipeline'),
}

/** `get` throws `Error('404 /path')`: true when the indexer build doesn't expose that endpoint. */
export const isNotFound = (error: Error | null | undefined) => !!error?.message.startsWith('404 ')
