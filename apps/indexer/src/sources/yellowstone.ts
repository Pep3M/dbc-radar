import Client, {
	CommitmentLevel,
	type SubscribeRequest,
	type SubscribeUpdate,
	type SubscribeUpdateTransaction,
} from '@triton-one/yellowstone-grpc'
import bs58 from 'bs58'
import { config } from '../config'
import { DBC_PROGRAM_ID } from '../decoder/dbc'
import type { RawTx } from '../domain/types'
import type { TxSource } from './types'

const PING_INTERVAL_MS = 15_000
const MAX_BACKOFF_MS = 30_000

const buildRequest = (fromSlot?: number): SubscribeRequest => ({
	accounts: {},
	slots: {},
	transactions: {
		dbc: {
			vote: false,
			failed: false,
			accountInclude: [DBC_PROGRAM_ID],
			accountExclude: [],
			accountRequired: [],
		},
	},
	transactionsStatus: {},
	blocks: {},
	blocksMeta: {},
	entry: {},
	blockFooter: {},
	accountsDataSlice: [],
	commitment: CommitmentLevel.CONFIRMED,
	fromSlot: fromSlot === undefined ? undefined : String(fromSlot),
})

const normalize = (update: SubscribeUpdateTransaction): RawTx | null => {
	const info = update.transaction
	const message = info?.transaction?.message
	if (!info || !message || !info.meta) return null
	const keys = [
		...message.accountKeys,
		...info.meta.loadedWritableAddresses,
		...info.meta.loadedReadonlyAddresses,
	].map((k) => bs58.encode(k))
	return {
		signature: bs58.encode(info.signature),
		slot: Number(update.slot),
		blockTime: Math.floor(Date.now() / 1000),
		signer: keys[0],
		innerInstructions: info.meta.innerInstructions.flatMap((group) =>
			group.instructions.map((ix) => ({ programId: keys[ix.programIdIndex], data: ix.data })),
		),
		tokenBalances: info.meta.postTokenBalances.map((b) => ({
			mint: b.mint,
			owner: b.owner,
			decimals: b.uiTokenAmount?.decimals ?? 0,
		})),
		receivedAt: Date.now(),
	}
}

/**
 * Primary source: Solami's Yellowstone gRPC firehose, filtered server-side to the DBC program.
 * Full transactions (inner instructions included) arrive in one message, so there is no
 * follow-up getTransaction call. On reconnect we resubscribe with `fromSlot` set to the last
 * slot we saw, so the gap is replayed instead of lost (inserts are idempotent).
 */
export const createYellowstoneSource = (): TxSource => {
	const stats = { reconnects: 0, lastSlot: 0, connectedAt: 0 }
	let stopped = false
	let current: { destroy: () => void } | null = null
	let pingTimer: ReturnType<typeof setInterval> | undefined

	const connect = async (onTx: (tx: RawTx) => void): Promise<void> => {
		const client = new Client(config.grpcUrl, config.solamiApiKey, undefined)
		await client.connect()
		const stream = await client.subscribe(buildRequest(stats.lastSlot || undefined))
		current = stream
		stats.connectedAt = Date.now()

		pingTimer = setInterval(() => stream.write(buildPing()), PING_INTERVAL_MS)

		await new Promise<void>((resolve) => {
			stream.on('data', (update: SubscribeUpdate) => {
				if (update.ping) {
					stream.write(buildPing())
					return
				}
				if (!update.transaction) return
				const tx = normalize(update.transaction)
				if (!tx) return
				if (tx.slot > stats.lastSlot) stats.lastSlot = tx.slot
				onTx(tx)
			})
			stream.on('error', (error) => {
				console.error('[grpc] stream error:', (error as Error).message)
				resolve()
			})
			stream.on('close', () => resolve())
			stream.on('end', () => resolve())
		})
		clearInterval(pingTimer)
		stream.destroy()
	}

	const buildPing = (): SubscribeRequest => ({ ...buildRequest(), ping: { id: 1 } })

	return {
		name: 'grpc',
		stats,
		async start(onTx) {
			// First connection is awaited so a bad key or endpoint fails fast at boot.
			let firstError: Error | null = null
			const firstConnected = new Promise<void>((resolve) => {
				const loop = async () => {
					let backoff = 500
					while (!stopped) {
						const startedAt = Date.now()
						try {
							const session = connect(onTx)
							setTimeout(resolve, 1500)
							await session
						} catch (error) {
							if (stats.reconnects === 0 && !stats.connectedAt) {
								firstError = error as Error
								resolve()
								return
							}
							console.error('[grpc] connect failed:', (error as Error).message)
						}
						if (stopped) return
						if (Date.now() - startedAt > 60_000) backoff = 500
						stats.reconnects++
						console.warn(`[grpc] reconnecting from slot ${stats.lastSlot} in ${backoff}ms`)
						await Bun.sleep(backoff)
						backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
					}
				}
				loop()
			})
			await firstConnected
			if (firstError) throw firstError
			console.log(`[grpc] subscribed to DBC transactions via ${config.grpcUrl}`)
		},
		async stop() {
			stopped = true
			clearInterval(pingTimer)
			current?.destroy()
		},
	}
}
