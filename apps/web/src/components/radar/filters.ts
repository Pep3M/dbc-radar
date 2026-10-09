import { RISK_HIGH } from '../ui'

export type Filters = {
	minVol: '0' | '100' | '1000'
	quote: 'all' | 'SOL' | 'USDC'
	pad: string
	hideRisk: boolean
}

export const DEFAULT_FILTERS: Filters = { minVol: '0', quote: 'all', pad: 'all', hideRisk: false }

type Filterable = {
	vol5: number
	score: number
	quoteSymbol: string | null
	launchpad: string | null
}

/** Client-side filters shared by the table and the scope (filtered-out blips dim to 14 %). */
export const passes = (p: Filterable, f: Filters) => {
	if (f.minVol !== '0' && p.vol5 < Number(f.minVol)) return false
	if (f.hideRisk && p.score >= RISK_HIGH) return false
	if (f.quote !== 'all' && p.quoteSymbol !== f.quote) return false
	if (f.pad !== 'all' && p.launchpad !== f.pad) return false
	return true
}
