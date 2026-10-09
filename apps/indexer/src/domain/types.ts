export type TokenBalance = {
	mint: string
	owner: string
	decimals: number
}

export type InnerInstruction = {
	programId: string
	data: Uint8Array
}

/** Source-agnostic transaction shape: every source normalizes to this before decoding. */
export type RawTx = {
	signature: string
	slot: number
	blockTime: number
	signer: string
	innerInstructions: InnerInstruction[]
	tokenBalances: TokenBalance[]
	receivedAt: number
}

export type PoolCreated = {
	kind: 'pool_created'
	pool: string
	config: string
	creator: string
	baseMint: string
	poolType: number
}

export type Swap = {
	kind: 'swap'
	pool: string
	config: string
	side: 'buy' | 'sell'
	trader: string
	quoteAmount: bigint
	baseAmount: bigint
	nextSqrtPrice: bigint
	quoteReserve: bigint
	migrationThreshold: bigint
	tradingFee: bigint
}

export type CurveComplete = {
	kind: 'curve_complete'
	pool: string
	config: string
	baseReserve: bigint
	quoteReserve: bigint
}

export type DbcEvent = PoolCreated | Swap | CurveComplete

export type DecodedTx = {
	tx: RawTx
	events: DbcEvent[]
}
