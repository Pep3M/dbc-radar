/*
 * Stateless relay for the "Public RPC vs Solami" race on /about. api.mainnet-beta.solana.com
 * answers 403 to any request with a browser Origin header, so the visitor's naive polling
 * client sends its JSON-RPC calls here and we forward them unchanged in meaning, without the
 * Origin header. Only the two read calls the race needs are allowed (DBC program signatures
 * and getTransaction by signature); params are rebuilt server-side, and nothing is cached:
 * status codes, including 429 and Retry-After, pass straight through.
 */

const UPSTREAM = 'https://api.mainnet-beta.solana.com'
const DBC_PROGRAM = 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN'
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/

const reject = (status: number, message: string) =>
	Response.json({ jsonrpc: '2.0', id: 1, error: { code: status, message } }, { status })

const rebuild = (body: unknown) => {
	if (!body || typeof body !== 'object') return null
	const { method, params } = body as { method?: unknown; params?: unknown }
	if (!Array.isArray(params)) return null
	if (method === 'getSignaturesForAddress' && params[0] === DBC_PROGRAM) {
		const limit = Number((params[1] as { limit?: unknown } | undefined)?.limit ?? 10)
		return [DBC_PROGRAM, { limit: Math.min(20, Math.max(1, limit || 10)), commitment: 'confirmed' }]
	}
	if (method === 'getTransaction' && typeof params[0] === 'string' && SIGNATURE.test(params[0])) {
		return [
			params[0],
			{ encoding: 'json', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
		]
	}
	return null
}

export async function POST(request: Request) {
	const raw = await request.text()
	if (raw.length > 2048) return reject(413, 'Body too large')
	let body: unknown
	try {
		body = JSON.parse(raw)
	} catch {
		return reject(400, 'Invalid JSON')
	}
	const params = rebuild(body)
	if (!params) return reject(400, 'Only the race calls are relayed')
	const method = (body as { method: string }).method

	let upstream: Response
	try {
		upstream = await fetch(UPSTREAM, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
			cache: 'no-store',
			signal: AbortSignal.timeout(10_000),
		})
	} catch {
		return reject(502, 'Public RPC unreachable')
	}
	const headers = new Headers({
		'content-type': upstream.headers.get('content-type') ?? 'application/json',
		'cache-control': 'no-store',
	})
	const retryAfter = upstream.headers.get('retry-after')
	if (retryAfter) headers.set('retry-after', retryAfter)
	return new Response(await upstream.text(), { status: upstream.status, headers })
}
