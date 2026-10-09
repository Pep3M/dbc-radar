import type { LatencySample, Pipeline, PipelineComponent } from './domain/api'

const WINDOW_S = 60
const P50_WINDOW = 200
const MAX_SAMPLES = 100
const SLOT_MEMORY = 2_000
const BLUR_PENDING_MS = 30_000

/** Events per trailing 60 s, in 1 s buckets (no per-event allocation). */
const rate = () => {
	const buckets = new Uint32Array(WINDOW_S)
	const stamps = new Float64Array(WINDOW_S)
	return {
		add(n = 1) {
			const sec = Math.floor(Date.now() / 1000)
			const i = sec % WINDOW_S
			if (stamps[i] !== sec) {
				stamps[i] = sec
				buckets[i] = 0
			}
			buckets[i] += n
		},
		perMin() {
			const now = Math.floor(Date.now() / 1000)
			let total = 0
			for (let i = 0; i < WINDOW_S; i++) if (now - stamps[i] < WINDOW_S) total += buckets[i]
			return total
		},
	}
}

/** Median over the last P50_WINDOW values. */
const median = () => {
	const values: number[] = []
	return {
		add(value: number) {
			values.push(value)
			if (values.length > P50_WINDOW) values.shift()
		},
		p50() {
			if (values.length === 0) return null
			const sorted = [...values].sort((a, b) => a - b)
			return Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10
		},
	}
}

const link = () => ({ connectedAt: 0, reconnects: 0, errors: 0, rate: rate(), latency: median() })
type Link = ReturnType<typeof link>

const component = (l: Link, connected: boolean): PipelineComponent => ({
	connected,
	perMin: l.rate.perMin(),
	latencyP50Ms: l.latency.p50(),
	connectedForMs: connected && l.connectedAt ? Date.now() - l.connectedAt : null,
	reconnects: l.reconnects,
	errors: l.errors,
})

/**
 * Process-wide measurements for the "Under the hood" page. Sources call into it on the hot
 * path, so everything is O(1) per event.
 *
 * Latency reference: the wall-clock moment this process first heard of a slot on the
 * Yellowstone stream (any slot status, inter-slot updates included, so usually
 * FIRST_SHRED_RECEIVED/CREATED_BANK). Neither the chain nor Blur gives a trustworthy
 * per-tx timestamp (blockTime has 1 s resolution), so both gRPC and Blur arrivals are
 * measured against this same local reference and are comparable with each other.
 */
const createTelemetry = () => {
	const startedAt = Date.now()
	const grpc = { ...link(), lastSlot: 0 }
	const blur = link()
	const dataApi = link()
	const indexer = { txs: rate(), events: rate(), process: median() }
	const sse = { clients: 0, pushes: rate(), chainToScreen: median() }

	const slotSeen = new Map<number, number>()
	const samples: LatencySample[] = []
	const sampleBySig = new Map<string, LatencySample>()
	// Blur can beat gRPC for a signature; remember its arrival until the gRPC copy shows up.
	const blurEarly = new Map<string, number>()

	const slotRef = (slot: number) => slotSeen.get(slot)

	return {
		grpc,
		blur,
		dataApi,
		/** Any slot update from Yellowstone; only the first sighting per slot counts. */
		slotSeen(slot: number, at = Date.now()) {
			if (slotSeen.has(slot)) return
			slotSeen.set(slot, at)
			if (slotSeen.size > SLOT_MEMORY) {
				const oldest = slotSeen.keys().next().value
				if (oldest !== undefined) slotSeen.delete(oldest)
			}
		},
		/**
		 * A gRPC tx. grpcMs = arrival − slot reference. Only txs with DBC events become chart
		 * samples (Blur only reports decoded swaps/creates, so others could never match).
		 */
		grpcTx(signature: string, slot: number, receivedAt: number, hasEvents: boolean) {
			grpc.rate.add()
			if (slot > grpc.lastSlot) grpc.lastSlot = slot
			const ref = slotRef(slot)
			if (ref === undefined || !hasEvents) return
			const grpcMs = Math.max(receivedAt - ref, 0)
			grpc.latency.add(grpcMs)
			const early = blurEarly.get(signature)
			blurEarly.delete(signature)
			const sample: LatencySample = {
				signature,
				grpcMs,
				blurMs: early === undefined ? null : Math.max(early - ref, 0),
				ts: receivedAt,
			}
			samples.push(sample)
			sampleBySig.set(signature, sample)
			if (samples.length > MAX_SAMPLES) {
				const dropped = samples.shift()
				if (dropped) sampleBySig.delete(dropped.signature)
			}
		},
		/** Any Blur message. Swaps carry signature + slot, so they get a latency. */
		blurMessage(signature?: string, slot?: number) {
			const now = Date.now()
			blur.rate.add()
			if (!signature || slot === undefined) return
			const ref = slotRef(slot)
			if (ref !== undefined) blur.latency.add(Math.max(now - ref, 0))
			const sample = sampleBySig.get(signature)
			if (sample) {
				if (sample.blurMs === null && ref !== undefined) sample.blurMs = Math.max(now - ref, 0)
				return
			}
			blurEarly.set(signature, now)
			if (blurEarly.size > 5_000) {
				for (const [sig, at] of blurEarly) {
					if (now - at < BLUR_PENDING_MS) break
					blurEarly.delete(sig)
				}
			}
		},
		dataApiRequest(ms: number, ok: boolean) {
			dataApi.rate.add()
			if (ok) dataApi.latency.add(ms)
			else dataApi.errors++
		},
		/** Decode + SQLite write of one tx. */
		processed(ms: number, events: number) {
			indexer.txs.add()
			if (events > 0) {
				indexer.events.add(events)
				indexer.process.add(ms)
			}
		},
		/** Live events were handed to SSE clients for a tx at `slot`. */
		pushed(slot: number, messages: number) {
			if (messages === 0) return
			sse.pushes.add(messages)
			const ref = slotRef(slot)
			if (ref !== undefined) sse.chainToScreen.add(Date.now() - ref)
		},
		sseClients(delta: number) {
			sse.clients += delta
		},
		snapshot(source: string, blurConnected: boolean): Pipeline {
			const matched = samples.filter((s) => s.blurMs !== null)
			return {
				source,
				startedAt,
				uptimeMs: Date.now() - startedAt,
				grpc: { ...component(grpc, grpc.connectedAt > 0), lastSlot: grpc.lastSlot },
				blur: component(blur, blurConnected),
				dataApi: component(dataApi, dataApi.rate.perMin() > 0),
				indexer: {
					perMin: indexer.txs.perMin(),
					eventsPerMin: indexer.events.perMin(),
					processP50Ms: indexer.process.p50(),
				},
				sse: {
					clients: sse.clients,
					pushesPerMin: sse.pushes.perMin(),
					chainToScreenP50Ms: sse.chainToScreen.p50(),
				},
				grpcFirstShare:
					matched.length === 0
						? null
						: matched.filter((s) => s.grpcMs < (s.blurMs ?? 0)).length / matched.length,
				samples: samples.map((s) => ({ ...s })),
			}
		},
	}
}

export const telemetry = createTelemetry()
