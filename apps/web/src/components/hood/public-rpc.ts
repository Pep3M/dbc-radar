/*
 * A deliberately naive public-RPC client, run in the visitor's browser for the hero race:
 * poll getSignaturesForAddress for the DBC program, then getTransaction for each new
 * signature, one request at a time, backing off on HTTP 429. Every number it reports is
 * measured here; nothing is simulated.
 *
 * api.mainnet-beta.solana.com answers 403 "Access forbidden" to requests that carry a browser
 * Origin header, so the first request goes direct (to prove that) and the rest go through a
 * stateless same-origin relay (`/about/rpc`) that forwards the same JSON-RPC call without the
 * Origin header. The relay only allows these two methods and never caches.
 */

export const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com'
export const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'
const RELAY = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/about/rpc`

export type RpcLog = {
	id: number
	/** ms since the run started. */
	t: number
	kind: 'ok' | 'sigs' | 'throttled' | 'error' | 'blocked'
	text: string
	code: string
}

export type RpcTrace = { t: number; kind: 'ok' | 'throttled' | 'error' }

export type RpcRun = {
	delivered: number
	requests: number
	http429: number
	errors: number
	latencies: number[]
	/** First 429 (ms since start), for the throttled band. */
	throttledAt: number | null
	/** A 429 backoff is in progress. */
	backingOff: boolean
	/** Request transport for the run, once known. */
	via: 'direct' | 'relay' | null
	trace: RpcTrace[]
	log: RpcLog[]
}

export const emptyRpcRun = (): RpcRun => ({
	delivered: 0,
	requests: 0,
	http429: 0,
	errors: 0,
	latencies: [],
	throttledAt: null,
	backingOff: false,
	via: null,
	trace: [],
	log: [],
})

// Remembered for the page lifetime so REPLAY doesn't re-prove the 403 each time.
let directBlocked: boolean | null = null
let logSeq = 0

const short = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`

type Call =
	| { method: 'getSignaturesForAddress'; limit: number }
	| { method: 'getTransaction'; signature: string }

const body = (call: Call) =>
	JSON.stringify({
		jsonrpc: '2.0',
		id: 1,
		method: call.method,
		params:
			call.method === 'getSignaturesForAddress'
				? [DBC_PROGRAM, { limit: call.limit, commitment: 'confirmed' }]
				: [
						call.signature,
						{ encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
					],
	})

type Reply = {
	status: number
	ms: number
	json: unknown
	retryAfter: number | null
	via: 'direct' | 'relay'
}

const post = async (
	url: string,
	call: Call,
	signal: AbortSignal,
	via: Reply['via'],
): Promise<Reply> => {
	const started = performance.now()
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: body(call),
		cache: 'no-store',
		signal,
	})
	const json = await res.json().catch(() => null)
	const retry = Number(res.headers.get('retry-after'))
	return {
		status: res.status,
		ms: performance.now() - started,
		json,
		retryAfter: Number.isFinite(retry) && retry > 0 ? retry * 1000 : null,
		via,
	}
}

const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms)
		signal.addEventListener('abort', () => {
			clearTimeout(timer)
			resolve()
		})
	})

const MAX_LOG = 9

/**
 * Runs until `signal` aborts or `durationMs` elapses. `onChange` fires after every request
 * with the same mutable `run` object (read it from a ref; don't copy it into React state).
 */
export const runPublicRpc = async ({
	run,
	t0,
	durationMs,
	signal,
	onChange,
}: {
	run: RpcRun
	t0: number
	durationMs: number
	signal: AbortSignal
	onChange: () => void
}) => {
	const elapsed = () => performance.now() - t0
	const log = (entry: Omit<RpcLog, 'id'>) => {
		run.log.unshift({ ...entry, id: ++logSeq })
		if (run.log.length > MAX_LOG) run.log.length = MAX_LOG
	}
	const seen = new Set<string>()
	const queue: string[] = []
	let streak = 0

	const send = async (call: Call): Promise<Reply> => {
		if (directBlocked !== true) {
			try {
				const reply = await post(PUBLIC_RPC, call, signal, 'direct')
				if (reply.status !== 403) {
					directBlocked = false
					return reply
				}
			} catch (e) {
				if (signal.aborted) throw e
				// CORS / network failure from the browser: fall through to the relay.
			}
			directBlocked = true
			run.requests++
			run.trace.push({ t: elapsed(), kind: 'error' })
			log({
				t: elapsed(),
				kind: 'blocked',
				text: 'browser → api.mainnet-beta · Access forbidden · switching to relay',
				code: '403',
			})
			onChange()
		}
		return post(RELAY, call, signal, 'relay')
	}

	while (!signal.aborted && elapsed() < durationMs) {
		const call: Call =
			queue.length === 0
				? { method: 'getSignaturesForAddress', limit: 10 }
				: { method: 'getTransaction', signature: queue.shift() as string }
		let reply: Reply
		try {
			reply = await send(call)
		} catch {
			if (signal.aborted) return
			run.requests++
			run.errors++
			run.trace.push({ t: elapsed(), kind: 'error' })
			log({ t: elapsed(), kind: 'error', text: `${call.method} → network error`, code: 'ERR' })
			onChange()
			await sleep(1000, signal)
			continue
		}
		if (signal.aborted || elapsed() > durationMs) return
		run.requests++
		run.via = reply.via
		const t = elapsed()
		const rpcError = (reply.json as { error?: { message?: string } } | null)?.error
		if (reply.status === 429) {
			run.http429++
			run.throttledAt ??= t
			const back =
				reply.retryAfter ?? Math.min(6000, 400 * 2 ** streak++) * (0.8 + Math.random() * 0.4)
			run.trace.push({ t, kind: 'throttled' })
			log({
				t,
				kind: 'throttled',
				text: `${call.method} → Too Many Requests · retry in ${(back / 1000).toFixed(1)}s`,
				code: '429',
			})
			if (call.method === 'getTransaction') queue.unshift(call.signature)
			run.backingOff = true
			onChange()
			await sleep(back, signal)
			run.backingOff = false
			continue
		}
		if (reply.status !== 200 || rpcError) {
			run.errors++
			run.trace.push({ t, kind: 'error' })
			log({
				t,
				kind: 'error',
				text: `${call.method} → ${rpcError?.message ?? `HTTP ${reply.status}`}`,
				code: String(reply.status),
			})
			onChange()
			await sleep(1000, signal)
			continue
		}
		streak = 0
		run.latencies.push(reply.ms)
		if (call.method === 'getSignaturesForAddress') {
			const sigs = ((reply.json as { result?: { signature: string }[] }).result ?? [])
				.map((r) => r.signature)
				.filter((s) => !seen.has(s))
			for (const s of sigs) seen.add(s)
			// Oldest first, like a client catching up.
			queue.push(...sigs.reverse())
			log({
				t,
				kind: 'sigs',
				text: `getSignaturesForAddress · ${sigs.length} new · ${Math.round(reply.ms)}ms`,
				code: '200',
			})
			if (sigs.length === 0) await sleep(400, signal)
		} else {
			const found = (reply.json as { result?: unknown }).result != null
			if (found) {
				run.delivered++
				run.trace.push({ t, kind: 'ok' })
			}
			log({
				t,
				kind: 'ok',
				text: `getTransaction ${short(call.signature)} · ${found ? '' : 'not found · '}${Math.round(reply.ms)}ms`,
				code: '200',
			})
		}
		onChange()
	}
}
