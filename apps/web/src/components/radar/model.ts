/*
 * Mutable scope model + canvas painters for the radar hero. Nothing here touches React: the
 * dashboard feeds the selected tab's filtered list (`syncPools`) and raw SSE events
 * (`applyEvent`) into the model, and the scope/strip canvases repaint it every frame. The scope
 * draws exactly the pools of the current tab, so it and the table are one view. Geometry and
 * timings follow the DBC Radar handoff (Component Specs › 01, DBC Radar System › Choreography);
 * the angle uses a log age scale so lists spanning minutes to days fit one turn.
 */
import type { LiveEvent, PoolSummary, RiskFlag } from '@/lib/api'

export const TAU = Math.PI * 2
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const TRAIL_MS = 30_000
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const easeOut = (k: number) => 1 - (1 - k) ** 3

export type ScopeMode = 'new' | 'progress' | 'hot' | 'graduated'

export type Blip = {
	pool: string
	mint: string | null
	symbol: string | null
	name: string | null
	launchpad: string | null
	quoteSymbol: string | null
	createdAt: number
	/** Angle reference: creation time, or graduation time on the Graduated tab. */
	t0: number
	progress: number
	vol5: number
	mcap: number | null
	score: number
	flags: RiskFlag[]
	lastTradeAt: number
	/** Born from an SSE launch and not yet confirmed by a snapshot (wall-clock ms), else 0. */
	liveSince: number
}

type Fx =
	| { k: 'trade'; pool: string; side: 'buy' | 'sell'; usd: number; t: number }
	| { k: 'ping'; pool: string; t: number }
	| { k: 'lock'; pool: string; t: number }

type Leaving = { a: number; s: number; symbol: string; t: number }
type Trail = { pool: string; r: number; side: 'buy' | 'sell'; t: number }

export type ScopeModel = {
	mode: ScopeMode
	/** The list has been synced at least once for this mode (no pings for the initial fill). */
	synced: boolean
	blips: Map<string, Blip>
	/** Full angle turn covers ages 0 → span (log scale). */
	span: number
	fx: Fx[]
	leaving: Leaving[]
	trail: Trail[]
	/** Arrival times (ms) of events in the trailing minute: drives the sweep period. */
	events: number[]
	gradFlash: number
	sweepA: number
	/** Table rows in display order: labels prefer the pools at the top of the table. */
	tableOrder: string[]
	/** Pool under the pointer in the table (cross-highlight). */
	tableHover: string | null
	/** Would a just-launched pool pass the current filters? */
	accept: (b: Blip) => boolean
}

export const createModel = (): ScopeModel => ({
	mode: 'new',
	synced: false,
	blips: new Map(),
	span: HOUR,
	fx: [],
	leaving: [],
	trail: [],
	events: [],
	gradFlash: 0,
	sweepA: 0,
	tableOrder: [],
	tableHover: null,
	accept: () => true,
})

/* ───────────────────────────── age scale ───────────────────────────── */

const SPANS = [HOUR, 6 * HOUR, DAY, 7 * DAY, 30 * DAY]
const TICKS: [number, string][] = [
	[MIN, '1m'],
	[5 * MIN, '5m'],
	[15 * MIN, '15m'],
	[HOUR, '1h'],
	[3 * HOUR, '3h'],
	[6 * HOUR, '6h'],
	[12 * HOUR, '12h'],
	[DAY, '24h'],
	[3 * DAY, '3d'],
	[7 * DAY, '7d'],
	[30 * DAY, '30d'],
]
const spanLabel = (span: number) => TICKS.find(([ms]) => ms === span)?.[1] ?? ''

/** 0..0.985 of a turn for an age, on a log scale anchored at one minute. */
export const ageFrac = (age: number, span: number) =>
	clamp(Math.log1p(Math.max(0, age) / MIN) / Math.log1p(span / MIN), 0, 1) * 0.985
export const angleAt = (frac: number) => -Math.PI / 2 + frac * TAU
export const angleOf = (t0: number, now: number, span: number) => angleAt(ageFrac(now - t0, span))

/** Labelled age ticks for the current span, thinned so labels never crowd. */
export const ageTicks = (span: number) => {
	const out: { frac: number; label: string }[] = []
	for (const [ms, label] of TICKS) {
		if (ms > span * 0.97) break
		const frac = ageFrac(ms, span)
		if (out.length && frac - out[out.length - 1].frac < 0.06) continue
		if (frac < 0.05) continue
		out.push({ frac, label })
	}
	return out
}
export const scaleLabel = (span: number) => `log · turn = ${spanLabel(span)}`

export const blipSize = (vol5: number) => 2 + Math.log10(1 + Math.max(0, vol5)) * 1.7

export const poolAge = (p: Pick<PoolSummary, 'createdAt' | 'firstSeenAt'>) =>
	p.createdAt ?? p.firstSeenAt

/**
 * Make the model mirror the selected tab's filtered list (exactly what the table lists).
 * Live progress newer than the snapshot is kept until the next poll catches up.
 */
export const syncPools = (
	model: ScopeModel,
	pools: PoolSummary[],
	mode: ScopeMode,
	now: number,
	t: number,
) => {
	if (mode !== model.mode) {
		model.mode = mode
		model.synced = false
		model.blips.clear()
		model.trail = []
		model.fx = []
	}
	const graduated = mode === 'graduated'
	const seen = new Set<string>()
	let maxAge = 0
	for (const p of pools) {
		const createdAt = poolAge(p)
		const t0 = graduated ? (p.graduatedAt ?? createdAt) : createdAt
		seen.add(p.pool)
		maxAge = Math.max(maxAge, now - t0)
		const prev = model.blips.get(p.pool)
		const polledTrade = p.lastTradeAt ?? 0
		const liveNewer = prev != null && prev.lastTradeAt > polledTrade
		// A pool that just appeared in the list (launch, or graduation on that tab) pings.
		if (!prev && model.synced && now - t0 < 30_000) model.fx.push({ k: 'ping', pool: p.pool, t })
		model.blips.set(p.pool, {
			pool: p.pool,
			mint: p.baseMint,
			symbol: p.symbol ?? prev?.symbol ?? null,
			name: p.name,
			launchpad: p.launchpad ?? null,
			quoteSymbol: p.quoteSymbol ?? null,
			createdAt,
			t0,
			progress: graduated ? 1 : liveNewer ? prev.progress : clamp(p.progress ?? 0, 0, 1),
			vol5: liveNewer ? Math.max(prev.vol5, p.volume5m) : p.volume5m,
			mcap: p.mcapUsd,
			score: p.risk.score,
			flags: p.risk.flags,
			lastTradeAt: Math.max(polledTrade, prev?.lastTradeAt ?? 0, createdAt),
			liveSince: 0,
		})
	}
	for (const [id, b] of model.blips) {
		if (seen.has(id)) continue
		// Launches born from SSE get a grace period before a snapshot has to confirm them.
		if (!b.liveSince || now - b.liveSince > 20_000) model.blips.delete(id)
	}
	model.span = SPANS.find((s) => s >= maxAge * 1.05) ?? SPANS[SPANS.length - 1]
	model.synced = true
}

/** Fold one raw SSE event into the model (called synchronously from `subscribe`). */
export const applyEvent = (model: ScopeModel, e: LiveEvent, now: number, t: number) => {
	if (e.type === 'alert') return
	model.events.push(now)
	if (model.events.length > 4000) model.events.splice(0, model.events.length - 4000)
	if (e.type === 'pool_created') {
		if (model.mode !== 'new' || model.blips.has(e.pool)) return
		const b: Blip = {
			pool: e.pool,
			mint: e.baseMint,
			symbol: e.symbol ?? null,
			name: null,
			launchpad: null,
			quoteSymbol: null,
			createdAt: now,
			t0: now,
			progress: 0,
			vol5: 0,
			mcap: null,
			score: 0,
			flags: [],
			lastTradeAt: now,
			liveSince: now,
		}
		if (!model.accept(b)) return
		model.blips.set(e.pool, b)
		model.fx.push({ k: 'ping', pool: e.pool, t })
		return
	}
	if (e.type === 'graduated') model.gradFlash = t
	const b = model.blips.get(e.pool)
	if (!b) return
	if (e.type === 'trade') {
		if (e.progress != null && model.mode !== 'graduated') b.progress = clamp(e.progress, 0, 1)
		b.vol5 += e.usdAmount ?? 0
		b.lastTradeAt = now
		if (!b.symbol && e.symbol) b.symbol = e.symbol
		model.fx.push({ k: 'trade', pool: b.pool, side: e.side, usd: e.usdAmount ?? 0, t })
		model.trail.push({ pool: b.pool, r: b.progress, side: e.side, t: now })
		if (model.trail.length > 1600) model.trail.shift()
	} else if (e.type === 'risk') {
		b.score = e.score
		if (!b.flags.includes(e.flag)) b.flags = [...b.flags, e.flag]
		if (!b.symbol && e.symbol) b.symbol = e.symbol
		if (e.flag === 'creator_sold') model.fx.push({ k: 'lock', pool: b.pool, t })
	} else if (e.type === 'graduated' && model.mode !== 'graduated') {
		// Leaves this tab's list: break orbit along its angle.
		model.leaving.push({
			a: angleOf(b.t0, now, model.span),
			s: blipSize(b.vol5),
			symbol: b.symbol ?? `${b.pool.slice(0, 4)}…`,
			t,
		})
		model.blips.delete(e.pool)
	}
}

export const eventsPerMinute = (model: ScopeModel, now: number) => {
	const cutoff = now - 60_000
	let i = 0
	while (i < model.events.length && model.events[i] < cutoff) i++
	if (i) model.events.splice(0, i)
	return model.events.length
}

/* ───────────────────────────── painting ───────────────────────────── */

export type Palette = Record<
	'ink' | 'ink2' | 'ink3' | 'line' | 'lineSoft' | 'signal' | 'buy' | 'sell' | 'risk' | 'bg',
	string
>

export const readPalette = (): Palette => {
	const cs = getComputedStyle(document.documentElement)
	const g = (n: string) => cs.getPropertyValue(`--color-${n}`).trim()
	return {
		ink: g('ink'),
		ink2: g('ink-2'),
		ink3: g('ink-3'),
		line: g('line'),
		lineSoft: g('line-soft'),
		signal: g('signal'),
		buy: g('buy'),
		sell: g('sell'),
		risk: g('risk'),
		bg: g('bg'),
	}
}

/** `oklch(L C H)` → `oklch(L C H / a)`. */
const alpha = (c: string, a: number) => c.replace(/\)\s*$/, ` / ${a})`)

export type BlipHit = { id: string; x: number; y: number }

export type PaintOpts = {
	C: Palette
	font: string
	reduced: boolean
	offline: boolean
	/** Pool hovered on the scope itself. */
	highlight: string | null
	/** rAF timestamp and frame delta. */
	ts: number
	dt: number
	now: number
}

const shape = (ctx: CanvasRenderingContext2D, x: number, y: number, s: number, score: number) => {
	ctx.beginPath()
	if (score >= 40) {
		const d = s * 1.25
		ctx.moveTo(x, y - d)
		ctx.lineTo(x + d, y)
		ctx.lineTo(x, y + d)
		ctx.lineTo(x - d, y)
		ctx.closePath()
		ctx.fill()
	} else if (score > 0) {
		const d = s * 1.2
		ctx.moveTo(x, y - d)
		ctx.lineTo(x + d, y)
		ctx.lineTo(x, y + d)
		ctx.lineTo(x - d, y)
		ctx.closePath()
		ctx.stroke()
	} else {
		ctx.arc(x, y, s, 0, TAU)
		ctx.fill()
	}
}

type Pos = { x: number; y: number; s: number; a: number }

/**
 * Labels: the hovered pools first (scope or table), then the pools at the top of the table, up
 * to 6, skipping any within 60×14 px of a label already placed.
 */
const paintLabels = (
	ctx: CanvasRenderingContext2D,
	model: ScopeModel,
	pos: Map<string, Pos>,
	o: PaintOpts,
	base: number,
) => {
	const forced = [o.highlight, model.tableHover].filter((id): id is string => id != null)
	const placed: [number, number][] = []
	let free = 0
	for (const id of new Set([...forced, ...model.tableOrder])) {
		const force = forced.includes(id)
		if (!force && free >= 6) break
		const b = model.blips.get(id)
		const P = pos.get(id)
		if (!b?.symbol || !P) continue
		const clear = !placed.some((l) => Math.abs(l[0] - P.x) < 60 && Math.abs(l[1] - P.y) < 14)
		if (!force && !clear) continue
		if (!force) free++
		placed.push([P.x, P.y])
		const rec = Math.exp(-(o.now - b.lastTradeAt) / 9000)
		ctx.globalAlpha = force ? 1 : base * clamp(0.55 + rec, 0, 1)
		ctx.fillStyle = force ? o.C.ink : o.C.ink2
		ctx.fillText(b.symbol.slice(0, 10), P.x + P.s + 6, P.y + 3.5)
	}
}

const sweepPeriod = (evpm: number) => clamp(1200 / Math.max(evpm, 1), 2.5, 12)

/** Polar scope: radius = curve progress, angle = age clockwise from NOW, size = vol 5m. */
export const paintScope = (
	ctx: CanvasRenderingContext2D,
	w: number,
	model: ScopeModel,
	o: PaintOpts,
): BlipHit[] => {
	const { C, ts, now, reduced: red, offline: off } = o
	const cx = w / 2
	const cy = w / 2
	const R = w / 2 - 40
	if (R <= 20) return []
	const base = off ? 0.4 : 1
	const rad = (pr: number) => R * (0.035 + 0.965 * pr)
	const mono = (weight: number, size: number) => `${weight} ${size}px ${o.font}`

	// Range rings, cross hairs, minute ticks.
	ctx.lineWidth = 1
	ctx.strokeStyle = C.line
	for (const q of [0.25, 0.5, 0.75]) {
		ctx.globalAlpha = base * 0.8
		ctx.beginPath()
		ctx.arc(cx, cy, rad(q), 0, TAU)
		ctx.stroke()
	}
	ctx.globalAlpha = base * 0.4
	ctx.beginPath()
	ctx.moveTo(cx - R, cy)
	ctx.lineTo(cx + R, cy)
	ctx.moveTo(cx, cy - R)
	ctx.lineTo(cx, cy + R)
	ctx.stroke()
	ctx.font = mono(500, 10)
	ctx.fillStyle = C.ink3
	ctx.textAlign = 'left'
	ctx.globalAlpha = base
	for (const q of [0.25, 0.5, 0.75]) ctx.fillText(`${q * 100}%`, cx + 5, cy - rad(q) - 4)
	ctx.strokeStyle = C.ink3
	for (let m = 0; m < 60; m++) {
		const a = -Math.PI / 2 + (m / 60) * TAU
		const len = m % 15 === 0 ? 10 : m % 5 === 0 ? 6 : 3
		ctx.globalAlpha = base * (m % 5 === 0 ? 0.9 : 0.5)
		ctx.beginPath()
		ctx.moveTo(cx + Math.cos(a) * (R + 7), cy + Math.sin(a) * (R + 7))
		ctx.lineTo(cx + Math.cos(a) * (R + 7 + len), cy + Math.sin(a) * (R + 7 + len))
		ctx.stroke()
	}
	ctx.globalAlpha = base
	ctx.textAlign = 'center'
	ctx.fillStyle = C.ink2
	ctx.fillText('NOW', cx, cy - R - 24)
	// Age scale (log): labelled major ticks where the list's ages actually fall.
	ctx.fillStyle = C.ink3
	ctx.strokeStyle = C.ink2
	ctx.lineWidth = 1.5
	for (const tick of ageTicks(model.span)) {
		const a = angleAt(tick.frac)
		const ux = Math.cos(a)
		const uy = Math.sin(a)
		ctx.globalAlpha = base
		ctx.beginPath()
		ctx.moveTo(cx + ux * (R + 6), cy + uy * (R + 6))
		ctx.lineTo(cx + ux * (R + 18), cy + uy * (R + 18))
		ctx.stroke()
		ctx.fillText(tick.label, cx + ux * (R + 30), cy + uy * (R + 30) + 4)
	}
	ctx.lineWidth = 1

	// Outer graduation ring: flares on a graduation (just brightens under reduced motion).
	const gk = model.gradFlash ? clamp(1 - (ts - model.gradFlash) / 1400, 0, 1) : 0
	ctx.globalAlpha = base
	ctx.strokeStyle = C.signal
	ctx.lineWidth = 1.5 + gk * (red ? 1.5 : 5)
	if (gk > 0 && !red) {
		ctx.shadowColor = C.signal
		ctx.shadowBlur = 28 * gk
	}
	ctx.beginPath()
	ctx.arc(cx, cy, R, 0, TAU)
	ctx.stroke()
	ctx.shadowBlur = 0
	ctx.textAlign = 'left'
	ctx.fillStyle = C.signal
	ctx.font = mono(600, 9.5)
	ctx.fillText('100% · GRADUATION', cx + 8, cy - R - 6)

	// Afterglow: one 1.5px dot per trade, fading over 30 s.
	let cut = 0
	for (const t of model.trail) {
		const age = (now - t.t) / TRAIL_MS
		const owner = model.blips.get(t.pool)
		if (age > 1 || !owner) {
			cut++
			continue
		}
		const r = rad(t.r)
		const ta = angleOf(owner.t0, t.t, model.span)
		ctx.globalAlpha = base * 0.55 * (1 - age)
		ctx.fillStyle = t.side === 'buy' ? C.buy : C.sell
		ctx.fillRect(cx + Math.cos(ta) * r - 0.75, cy + Math.sin(ta) * r - 0.75, 1.5, 1.5)
	}
	if (cut > 64) model.trail = model.trail.filter((t) => now - t.t < TRAIL_MS)

	// Sweep: period = 1200 / ev·min, clamped 2.5–12 s. Stopped when offline or reduced.
	const sweeping = !off && !red
	if (sweeping) {
		const period = sweepPeriod(eventsPerMinute(model, now))
		model.sweepA = (model.sweepA + (o.dt / 1000) * (TAU / period)) % TAU
		const sw = 1.1
		const start = model.sweepA - sw
		const g = ctx.createConicGradient?.(start, cx, cy)
		if (g) {
			g.addColorStop(0, alpha(C.signal, 0))
			g.addColorStop(sw / TAU - 0.0005, alpha(C.signal, 0.2))
			g.addColorStop(sw / TAU, alpha(C.signal, 0))
			ctx.globalAlpha = 1
			ctx.fillStyle = g
			ctx.beginPath()
			ctx.moveTo(cx, cy)
			ctx.arc(cx, cy, R, start, model.sweepA)
			ctx.closePath()
			ctx.fill()
		}
		ctx.strokeStyle = C.signal
		ctx.lineWidth = 1.2
		ctx.globalAlpha = 0.75
		ctx.beginPath()
		ctx.moveTo(cx, cy)
		ctx.lineTo(cx + Math.cos(model.sweepA) * R, cy + Math.sin(model.sweepA) * R)
		ctx.stroke()
	}

	// Blips.
	const pos = new Map<string, Pos>()
	const hits: BlipHit[] = []
	ctx.font = mono(500, 10)
	ctx.textAlign = 'left'
	for (const b of model.blips.values()) {
		const a = angleOf(b.t0, now, model.span)
		const r = rad(b.progress)
		const x = cx + Math.cos(a) * r
		const y = cy + Math.sin(a) * r
		const s = blipSize(b.vol5)
		const rec = Math.exp(-(now - b.lastTradeAt) / 9000)
		let swk = 0
		if (sweeping) {
			const d = (((model.sweepA - a) % TAU) + TAU) % TAU
			swk = d < 1.2 ? 1 - d / 1.2 : 0
		}
		const col = b.score >= 40 ? C.risk : C.ink
		ctx.globalAlpha = base * clamp(0.32 + 0.6 * rec + 0.3 * swk, 0, 1)
		ctx.fillStyle = col
		ctx.strokeStyle = col
		ctx.lineWidth = 1.3
		shape(ctx, x, y, s, b.score)
		if (b.progress >= 0.8) {
			ctx.globalAlpha = base * 0.85
			ctx.strokeStyle = C.signal
			ctx.lineWidth = 1
			ctx.beginPath()
			ctx.arc(x, y, s + 4, 0, TAU)
			ctx.stroke()
		}
		if (b.pool === o.highlight || b.pool === model.tableHover) {
			ctx.globalAlpha = 1
			ctx.strokeStyle = C.ink
			ctx.lineWidth = 1
			ctx.beginPath()
			ctx.arc(x, y, s + 8, 0, TAU)
			ctx.stroke()
		}
		pos.set(b.pool, { x, y, s, a })
		hits.push({ id: b.pool, x, y })
	}
	paintLabels(ctx, model, pos, o, base)

	// Graduation: blip breaks orbit along its angle, 12-ray burst at the exit point.
	model.leaving = model.leaving.filter((L) => ts - L.t < 1400)
	for (const L of model.leaving) {
		const k = (ts - L.t) / 1400
		const e = easeOut(k)
		const ux = Math.cos(L.a)
		const uy = Math.sin(L.a)
		const r = red ? R : R + e * R * 0.42
		ctx.globalAlpha = 1 - k
		ctx.strokeStyle = C.signal
		ctx.fillStyle = C.signal
		ctx.lineWidth = 2
		if (!red) {
			ctx.beginPath()
			ctx.moveTo(cx + ux * R, cy + uy * R)
			ctx.lineTo(cx + ux * r, cy + uy * r)
			ctx.stroke()
		}
		ctx.beginPath()
		ctx.arc(cx + ux * r, cy + uy * r, Math.max(3, L.s), 0, TAU)
		ctx.fill()
		if (!red && k < 0.55) {
			const kk = k / 0.55
			ctx.globalAlpha = 1 - kk
			ctx.lineWidth = 1.5
			for (let i = 0; i < 12; i++) {
				const bb = (i / 12) * TAU
				const r0 = 6 + kk * 10
				const r1 = 10 + kk * 34
				ctx.beginPath()
				ctx.moveTo(cx + ux * R + Math.cos(bb) * r0, cy + uy * R + Math.sin(bb) * r0)
				ctx.lineTo(cx + ux * R + Math.cos(bb) * r1, cy + uy * R + Math.sin(bb) * r1)
				ctx.stroke()
			}
			ctx.lineWidth = 1
			ctx.beginPath()
			ctx.arc(cx + ux * R, cy + uy * R, 8 + kk * 46, 0, TAU)
			ctx.stroke()
		}
		ctx.globalAlpha = clamp(1.4 - k * 1.4, 0, 1)
		ctx.font = mono(700, 11)
		ctx.textAlign = ux < 0 ? 'right' : 'left'
		ctx.fillText(`${L.symbol} GRADUATED`, cx + ux * (r + 12), cy + uy * (r + 12) + 4)
		ctx.textAlign = 'left'
	}

	paintFx(ctx, model, pos, o, base)
	ctx.globalAlpha = 1
	return hits
}

/** Trade rings + push/pull ticks, launch ping, creator-sold target lock. */
const paintFx = (
	ctx: CanvasRenderingContext2D,
	model: ScopeModel,
	pos: Map<string, { x: number; y: number; s: number; a: number }>,
	o: PaintOpts,
	base: number,
) => {
	const { C, ts, reduced: red } = o
	model.fx = model.fx.filter(
		(fx) => ts - fx.t < (fx.k === 'lock' ? 1700 : fx.k === 'ping' ? 1000 : 650),
	)
	for (const fx of model.fx) {
		const P = pos.get(fx.pool)
		if (!P) continue
		if (fx.k === 'trade') {
			if (red) continue
			const k = (ts - fx.t) / 650
			const e = easeOut(k)
			const col = fx.side === 'buy' ? C.buy : C.sell
			ctx.globalAlpha = base * (1 - k) * 0.9
			ctx.strokeStyle = col
			ctx.lineWidth = 1.2
			ctx.beginPath()
			ctx.arc(P.x, P.y, P.s + 2 + e * (4 + Math.log10(1 + fx.usd) * 6), 0, TAU)
			ctx.stroke()
			// Buys shoot a tick outward (towards graduation), sells inward.
			const dir = fx.side === 'buy' ? 1 : -1
			const ux = Math.cos(P.a) * dir
			const uy = Math.sin(P.a) * dir
			const r0 = P.s + 3 + e * 6
			const r1 = r0 + 4 + e * 6
			ctx.lineWidth = 2
			ctx.beginPath()
			ctx.moveTo(P.x + ux * r0, P.y + uy * r0)
			ctx.lineTo(P.x + ux * r1, P.y + uy * r1)
			ctx.stroke()
		} else if (fx.k === 'ping') {
			const k = (ts - fx.t) / 1000
			ctx.strokeStyle = C.ink
			ctx.lineWidth = 1
			if (red) {
				ctx.globalAlpha = 0.8
				ctx.beginPath()
				ctx.arc(P.x, P.y, 9, 0, TAU)
				ctx.stroke()
				continue
			}
			for (const lag of [0, 0.28]) {
				const kk = clamp((k - lag) / (1 - lag), 0, 1)
				if (kk <= 0) continue
				ctx.globalAlpha = base * (1 - kk)
				ctx.beginPath()
				ctx.arc(P.x, P.y, 3 + easeOut(kk) * 26, 0, TAU)
				ctx.stroke()
			}
		} else {
			const k = (ts - fx.t) / 1700
			const sz = red || k > 0.15 ? 12 : 36 - 24 * easeOut(k / 0.15)
			ctx.globalAlpha = k > 0.15 && !red ? (Math.floor(k * 14) % 2 ? 0.45 : 1) : 1
			ctx.strokeStyle = C.risk
			ctx.lineWidth = 2
			const L = 6
			for (const [sx, sy] of [
				[-1, -1],
				[1, -1],
				[1, 1],
				[-1, 1],
			]) {
				const ex = P.x + sx * sz
				const ey = P.y + sy * sz
				ctx.beginPath()
				ctx.moveTo(ex - sx * L, ey)
				ctx.lineTo(ex, ey)
				ctx.lineTo(ex, ey - sy * L)
				ctx.stroke()
			}
			ctx.fillStyle = C.risk
			ctx.font = `700 10px ${o.font}`
			ctx.globalAlpha = 1
			ctx.fillText('CREATOR SOLD', P.x + sz + 6, P.y - sz + 4)
		}
	}
}

/** Mobile strip: x = curve progress, rows = age (newest on top), right edge = graduation. */
export const paintStrip = (
	ctx: CanvasRenderingContext2D,
	w: number,
	h: number,
	model: ScopeModel,
	o: PaintOpts,
): BlipHit[] => {
	const { C, now, ts, reduced: red, offline: off } = o
	const L = 10
	const R = 26
	const T = 12
	const B = 12
	const base = off ? 0.4 : 1
	const X = (pr: number) => L + pr * (w - L - R)
	const Y = (age: number) => T + age * (h - T - B)
	ctx.strokeStyle = C.lineSoft
	ctx.lineWidth = 1
	ctx.globalAlpha = base
	for (const q of [0.25, 0.5, 0.75]) {
		ctx.beginPath()
		ctx.moveTo(X(q) + 0.5, T)
		ctx.lineTo(X(q) + 0.5, h - B)
		ctx.stroke()
	}
	let x0 = -1
	if (!off) {
		if (red) x0 = X(0.7)
		else {
			const period = sweepPeriod(eventsPerMinute(model, now))
			model.sweepA = (model.sweepA + (o.dt / 1000) * (TAU / period)) % TAU
			x0 = X(model.sweepA / TAU)
		}
		const gr = ctx.createLinearGradient(x0 - 80, 0, x0, 0)
		gr.addColorStop(0, alpha(C.signal, 0))
		gr.addColorStop(1, alpha(C.signal, 0.22))
		ctx.fillStyle = gr
		ctx.globalAlpha = 1
		ctx.fillRect(x0 - 80, T, 80, h - T - B)
		ctx.strokeStyle = C.signal
		ctx.globalAlpha = 0.7
		ctx.beginPath()
		ctx.moveTo(x0, T)
		ctx.lineTo(x0, h - B)
		ctx.stroke()
	}
	const hits: BlipHit[] = []
	const pos = new Map<string, { x: number; y: number; s: number; a: number }>()
	for (const b of model.blips.values()) {
		const age = ageFrac(now - b.t0, model.span) / 0.985
		const x = X(b.progress)
		const y = Y(age)
		const d = x0 - x
		const sw = x0 >= 0 && d > 0 && d < 90 ? 1 - d / 90 : 0
		const s = blipSize(b.vol5) * 0.7
		const col = b.score >= 40 ? C.risk : C.ink
		ctx.globalAlpha = base * Math.min(1, 0.35 + 0.65 * (1 - age) * 0.7 + sw * 0.5)
		ctx.fillStyle = col
		ctx.strokeStyle = col
		ctx.lineWidth = 1.3
		shape(ctx, x, y, s, b.score)
		if (b.progress >= 0.8) {
			ctx.globalAlpha = base * 0.85
			ctx.strokeStyle = C.signal
			ctx.lineWidth = 1
			ctx.beginPath()
			ctx.arc(x, y, s + 4, 0, TAU)
			ctx.stroke()
		}
		// Push/pull along x: buys point right (towards graduation), sells left.
		pos.set(b.pool, { x, y, s, a: 0 })
		hits.push({ id: b.pool, x, y })
	}
	const gk = model.gradFlash ? clamp(1 - (ts - model.gradFlash) / 1400, 0, 1) : 0
	ctx.globalAlpha = base
	ctx.strokeStyle = C.signal
	ctx.lineWidth = 2 + gk * 3
	ctx.beginPath()
	ctx.moveTo(X(1) + 0.5, T - 4)
	ctx.lineTo(X(1) + 0.5, h - B + 4)
	ctx.stroke()
	model.leaving = model.leaving.filter((Lv) => ts - Lv.t < 1400)
	paintFx(ctx, model, pos, o, base)
	ctx.globalAlpha = 1
	return hits
}
