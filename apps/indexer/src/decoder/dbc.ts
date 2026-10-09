import { BorshCoder, type Idl } from '@coral-xyz/anchor'
import {
	DYNAMIC_BONDING_CURVE_PROGRAM_ID,
	DynamicBondingCurveIdl,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import type { DbcEvent, RawTx } from '../domain/types'

export const DBC_PROGRAM_ID = DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58()

// Anchor `emit_cpi!` prefixes the self-invoke instruction data with this tag.
const EVENT_IX_TAG = Uint8Array.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d])

// DBC TradeDirection enum: BaseToQuote = 0, QuoteToBase = 1.
const QUOTE_TO_BASE = 1

const coder = new BorshCoder(DynamicBondingCurveIdl as Idl)

type Fields = Record<string, unknown>

const field = (obj: Fields, snake: string): unknown => {
	if (snake in obj) return obj[snake]
	const camel = snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
	return obj[camel]
}

const str = (obj: Fields, key: string) => String(field(obj, key))
const big = (obj: Fields, key: string) => BigInt(String(field(obj, key)))

const startsWithTag = (data: Uint8Array) => EVENT_IX_TAG.every((byte, i) => data[i] === byte)

const toEvent = (name: string, data: Fields, signer: string): DbcEvent | null => {
	switch (name) {
		case 'EvtInitializePool':
		case 'EvtInitializePoolWithTransferHook':
			return {
				kind: 'pool_created',
				pool: str(data, 'pool'),
				config: str(data, 'config'),
				creator: str(data, 'creator'),
				baseMint: str(data, 'base_mint'),
				poolType: Number(field(data, 'pool_type')),
			}
		case 'EvtSwap2':
		case 'EvtSwap2WithTransferHook': {
			const result = field(data, 'swap_result') as Fields
			const isBuy = Number(field(data, 'trade_direction')) === QUOTE_TO_BASE
			const input = big(result, 'included_fee_input_amount')
			const output = big(result, 'output_amount')
			return {
				kind: 'swap',
				pool: str(data, 'pool'),
				config: str(data, 'config'),
				side: isBuy ? 'buy' : 'sell',
				trader: signer,
				quoteAmount: isBuy ? input : output,
				baseAmount: isBuy ? output : input,
				nextSqrtPrice: big(result, 'next_sqrt_price'),
				quoteReserve: big(data, 'quote_reserve_amount'),
				migrationThreshold: big(data, 'migration_threshold'),
				tradingFee: big(result, 'trading_fee'),
			}
		}
		case 'EvtCurveComplete':
		case 'EvtCurveCompleteWithTransferHook':
			return {
				kind: 'curve_complete',
				pool: str(data, 'pool'),
				config: str(data, 'config'),
				baseReserve: big(data, 'base_reserve'),
				quoteReserve: big(data, 'quote_reserve'),
			}
		default:
			return null
	}
}

export const decodeDbcEvents = (tx: RawTx): DbcEvent[] => {
	const events: DbcEvent[] = []
	for (const ix of tx.innerInstructions) {
		if (ix.programId !== DBC_PROGRAM_ID || ix.data.length <= 16 || !startsWithTag(ix.data)) continue
		const decoded = coder.events.decode(Buffer.from(ix.data.subarray(8)).toString('base64'))
		if (!decoded) continue
		const event = toEvent(decoded.name, decoded.data as Fields, tx.signer)
		if (event) events.push(event)
	}
	return events
}
