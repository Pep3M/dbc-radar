import { Connection, PublicKey, type VersionedTransactionResponse } from '@solana/web3.js'
import bs58 from 'bs58'
import { config } from '../config'
import { DBC_PROGRAM_ID } from '../decoder/dbc'
import type { RawTx } from '../domain/types'
import type { TxHandler, TxSource } from './types'

const MAX_QUEUE = 500

export const normalizeRpcTx = (signature: string, res: VersionedTransactionResponse): RawTx => {
	const message = res.transaction.message
	const loaded = res.meta?.loadedAddresses
	const keys = [
		...message.staticAccountKeys.map((k) => k.toBase58()),
		...(loaded?.writable ?? []).map((k) => k.toBase58()),
		...(loaded?.readonly ?? []).map((k) => k.toBase58()),
	]
	return {
		signature,
		slot: res.slot,
		blockTime: res.blockTime ?? Math.floor(Date.now() / 1000),
		signer: keys[0],
		innerInstructions: (res.meta?.innerInstructions ?? []).flatMap((group) =>
			group.instructions.map((ix) => ({
				programId: keys[ix.programIdIndex],
				data: bs58.decode(ix.data),
			})),
		),
		tokenBalances: (res.meta?.postTokenBalances ?? []).map((b) => ({
			mint: b.mint,
			owner: b.owner ?? '',
			decimals: b.uiTokenAmount.decimals,
		})),
		receivedAt: Date.now(),
	}
}

/**
 * Fallback source for running without a Solami key: logsSubscribe gives only signatures,
 * so every event costs an extra getTransaction round trip. Public RPC rate limits make
 * this lossy under load — the queue drops the oldest signatures when it fills up.
 */
export const createRpcSource = (): TxSource => {
	const connection = new Connection(config.rpcUrl, {
		commitment: 'confirmed',
		wsEndpoint: config.wsUrl,
	})
	const queue: string[] = []
	let inFlight = 0
	let subscriptionId: number | null = null
	let onTx: TxHandler = () => {}
	let dropped = 0

	const fetchTx = async (signature: string, attempt = 0): Promise<void> => {
		try {
			const res = await connection.getTransaction(signature, {
				commitment: 'confirmed',
				maxSupportedTransactionVersion: 1,
			})
			if (res) onTx(normalizeRpcTx(signature, res))
			else if (attempt < 3) {
				await Bun.sleep(500 * (attempt + 1))
				return fetchTx(signature, attempt + 1)
			}
		} catch (error) {
			if (attempt < 3) {
				await Bun.sleep(1000 * 2 ** attempt)
				return fetchTx(signature, attempt + 1)
			}
			console.warn(`[rpc] getTransaction failed for ${signature}:`, (error as Error).message)
		}
	}

	const pump = () => {
		while (inFlight < config.rpcMaxConcurrency && queue.length > 0) {
			const signature = queue.shift() as string
			inFlight++
			fetchTx(signature).finally(() => {
				inFlight--
				pump()
			})
		}
	}

	return {
		name: 'rpc',
		async start(handler) {
			onTx = handler
			subscriptionId = connection.onLogs(
				new PublicKey(DBC_PROGRAM_ID),
				(logs) => {
					if (logs.err) return
					if (queue.length >= MAX_QUEUE) {
						queue.shift()
						if (++dropped % 100 === 1) console.warn(`[rpc] queue full, dropped ${dropped} txs`)
					}
					queue.push(logs.signature)
					pump()
				},
				'confirmed',
			)
			console.log(`[rpc] subscribed to DBC logs via ${config.rpcUrl}`)
		},
		async stop() {
			if (subscriptionId !== null) await connection.removeOnLogsListener(subscriptionId)
		},
	}
}
