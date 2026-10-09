import type {
	GlobalStats,
	Health,
	PoolDetail,
	PoolSort,
	PoolSummary,
} from '@dbc-radar/indexer/types'

export type {
	GlobalStats,
	Health,
	LiveEvent,
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
}
