import { config } from '../config'
import { telemetry } from '../telemetry'

export type TokenMetadata = {
	address: string
	name: string | null
	symbol: string | null
	image: string | null
	socials?: { x?: string | null; website?: string | null } | null
}

export type Holder = {
	owner: string
	amount: number
	pct: string
	tags?: string[]
}

export type HoldersResponse = {
	mint: string
	holders: number
	holders_exact: boolean
	supply: number
	top: Holder[]
}

const get = async <T>(path: string, params: Record<string, string>): Promise<T> => {
	const query = new URLSearchParams({ chain: 'solana', ...params })
	// Header auth keeps the key out of URLs, and therefore out of proxy and access logs.
	const startedAt = performance.now()
	try {
		const res = await fetch(`${config.dataApiUrl}${path}?${query}`, {
			headers: { 'x-api-key': config.solamiApiKey },
			signal: AbortSignal.timeout(10_000),
		})
		if (!res.ok) throw new Error(`Solami Data API ${path} → ${res.status}`)
		const body = (await res.json()) as T
		telemetry.dataApiRequest(performance.now() - startedAt, true)
		return body
	} catch (error) {
		telemetry.dataApiRequest(performance.now() - startedAt, false)
		throw error
	}
}

export const dataApi = {
	metadata: (mints: string[]) =>
		get<TokenMetadata[]>('/data/token/metadata', { address: mints.join(',') }),
	holders: (mint: string) => get<HoldersResponse>('/data/token/holders', { address: mint }),
}
