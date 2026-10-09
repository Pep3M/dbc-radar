const WSOL = 'So11111111111111111111111111111111111111112'

const STABLE_QUOTES = new Set([
	'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
	'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', // USD1
	'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
])

const REFRESH_MS = 60_000
const JUPITER_BATCH = 50

/**
 * Quote-token → USD conversion so pools quoted in SOL, stables or any other token can be
 * ranked together. Unknown quote mints are priced on first sight; `onNewPrice` lets the
 * caller backfill trades that were stored before the price was known.
 */
export const createPriceFeed = (onNewPrice: (mint: string, usd: number) => void = () => {}) => {
	const usdByMint = new Map<string, number>()
	const tracked = new Set<string>([WSOL])
	const pending = new Set<string>()

	const fetchPrices = async (mints: string[]) => {
		for (let i = 0; i < mints.length; i += JUPITER_BATCH) {
			const ids = mints.slice(i, i + JUPITER_BATCH).join(',')
			try {
				const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids}`)
				const body = (await res.json()) as Record<string, { usdPrice?: number }>
				for (const [mint, entry] of Object.entries(body)) {
					if (typeof entry?.usdPrice !== 'number') continue
					const isNew = !usdByMint.has(mint)
					usdByMint.set(mint, entry.usdPrice)
					if (isNew) onNewPrice(mint, entry.usdPrice)
				}
			} catch (error) {
				console.warn('[prices] refresh failed:', (error as Error).message)
			}
		}
	}

	const refresh = () => fetchPrices([...tracked])
	const timer = setInterval(refresh, REFRESH_MS)

	const track = (mint: string) => {
		if (tracked.has(mint) || STABLE_QUOTES.has(mint)) return
		tracked.add(mint)
		pending.add(mint)
		queueMicrotask(() => {
			if (pending.size === 0) return
			const batch = [...pending]
			pending.clear()
			fetchPrices(batch)
		})
	}

	return {
		ready: refresh(),
		solUsd: () => usdByMint.get(WSOL) ?? null,
		quoteToUsd(quoteMint: string | null, amount: number): number | null {
			if (!quoteMint) return null
			if (STABLE_QUOTES.has(quoteMint)) return amount
			const usd = usdByMint.get(quoteMint)
			if (usd === undefined) {
				track(quoteMint)
				return null
			}
			return amount * usd
		},
		stop: () => clearInterval(timer),
	}
}

export type PriceFeed = ReturnType<typeof createPriceFeed>
