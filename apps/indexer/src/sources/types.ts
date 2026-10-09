import type { RawTx } from '../domain/types'

export type TxHandler = (tx: RawTx) => void

export type TxSource = {
	name: string
	stats?: Record<string, number>
	start: (onTx: TxHandler) => Promise<void>
	stop: () => Promise<void>
}
