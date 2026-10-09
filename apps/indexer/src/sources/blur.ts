import { config } from '../config'

export type BlurMetadata = {
	type: 'metadata'
	mint: string
	name: string | null
	symbol: string | null
	logo_uri?: string | null
	socials?: { x?: string | null; website?: string | null }
}

export type BlurTokenUpdate = {
	type: 'token_update'
	mint: string
	pool: string
	mcap_usd: string
	liquidity_usd: string
	block_time: number
}

export type BlurSwap = {
	type: 'swap'
	signature: string
	indexed_at: number
}

export type BlurMessage = BlurMetadata | BlurTokenUpdate | BlurSwap | { type: string }

const MAX_BACKOFF_MS = 30_000

/**
 * Solami Blur: decoded market data over WebSocket, filtered server-side to Meteora DBC.
 * The gRPC stream stays the source of truth for curve state; Blur adds what raw instructions
 * don't carry: token metadata, market cap and liquidity.
 */
export const createBlurStream = (onMessage: (message: BlurMessage) => void) => {
	const stats = { messages: 0, reconnects: 0, connected: 0 }
	let socket: WebSocket | null = null
	let stopped = false
	let backoff = 500

	const connect = () => {
		// Blur only accepts the key as a query param; it never leaves this process.
		const url = `${config.blurWsUrl}?chain=solana&dex=meteora_dbc&api_key=${config.solamiApiKey}`
		socket = new WebSocket(url)
		socket.onopen = () => {
			stats.connected = 1
			backoff = 500
			console.log('[blur] connected, filter dex=meteora_dbc')
		}
		socket.onmessage = (event) => {
			stats.messages++
			try {
				onMessage(JSON.parse(String(event.data)) as BlurMessage)
			} catch (error) {
				console.warn('[blur] bad message:', (error as Error).message)
			}
		}
		socket.onclose = (event) => {
			stats.connected = 0
			if (stopped) return
			stats.reconnects++
			console.warn(`[blur] closed (${event.code}), reconnecting in ${backoff}ms`)
			setTimeout(connect, backoff)
			backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
		}
	}

	return {
		stats,
		start: connect,
		stop() {
			stopped = true
			socket?.close()
		},
	}
}
