import { config } from './config'
import type {
	AlertDelivery,
	AlertFired,
	AlertPayload,
	AlertsState,
	AlertType,
	LiveEvent,
	PoolSummary,
	RiskFlag,
} from './domain/api'
import type { Metrics } from './metrics'
import type { Db } from './store/db'
import { CURVE_LEVELS, createTelegramBot, type TelegramAlert } from './telegram'

const MAX_ATTEMPTS = 4 // first try + 3 retries
const BACKOFF_MS = 500
const TIMEOUT_MS = 5_000

const RISK_FLAGS: RiskFlag[] = [
	'creator_sold',
	'whale_buyer',
	'wash_trading',
	'dumping',
	'concentrated',
	'fresh_wallets',
]

const FLAG_LABELS: Record<RiskFlag, string> = {
	creator_sold: 'creator sold',
	whale_buyer: 'whale buyer',
	wash_trading: 'wash trading',
	dumping: 'dumping',
	concentrated: 'top 10 > 50%',
	fresh_wallets: 'fresh wallets',
}

const duration = (ms: number) => {
	const s = Math.round(ms / 1000)
	if (s < 60) return `${s}s`
	const m = Math.floor(s / 60)
	if (m < 60) return `${m}m ${s % 60}s`
	return `${Math.floor(m / 60)}h ${m % 60}m`
}

const usd = (n: number) =>
	n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(n >= 100 ? 0 : 2)}`

const hostOf = (url: string | null) => {
	if (!url) return null
	try {
		return new URL(url).hostname
	} catch {
		return null
	}
}

type Row = {
	id: number
	type: AlertType
	pool: string
	symbol: string | null
	detail: string
	payload: string
	deliveries: string
	ts: number
}

const toFired = (row: Row): AlertFired => ({
	id: row.id,
	type: row.type,
	pool: row.pool,
	symbol: row.symbol,
	detail: row.detail,
	payload: JSON.parse(row.payload),
	deliveries: JSON.parse(row.deliveries),
	ts: row.ts,
})

/**
 * Alerts, configured only through env (there is deliberately no write API). Every trigger is
 * recorded in SQLite even with no destination configured, deduplicated per pool (and flag),
 * then delivered to a signed webhook and/or Telegram in the background. Telegram subscribers
 * (telegram.ts) also get their own triggers: curve crossings at 50/70/80/90 % and flags or
 * graduations outside the site-wide rules, deduplicated in `telegram_sent`.
 */
/** `publish` broadcasts each newly recorded alert on the live stream (SSE) as `{ type: 'alert' }`. */
export const createAlerts = (
	db: Db,
	metrics: Metrics,
	publish: (event: LiveEvent) => void = () => {},
) => {
	const cfg = config.alerts
	const curveEnabled = cfg.curveThreshold > 0 && cfg.curveThreshold < 1
	const riskFlags = cfg.flags.filter((f): f is RiskFlag => RISK_FLAGS.includes(f as RiskFlag))
	const telegram = cfg.telegramToken
		? createTelegramBot(db, {
				token: cfg.telegramToken,
				polling: cfg.telegramPolling,
				fixedChatId: cfg.telegramChatId,
				publicUrl: config.publicUrl,
			})
		: null
	const secrets = [cfg.webhookUrl, cfg.webhookSecret, cfg.telegramToken].filter(Boolean) as string[]
	const keyOf = (type: AlertType, pool: string, flag?: RiskFlag) =>
		[type, pool, flag].filter(Boolean).join(':')
	// Mirrors the UNIQUE dedupe_key column so repeat triggers (every swap above the threshold)
	// are dropped before touching SQLite.
	const firedKeys = new Set(
		db
			.query<{ dedupe_key: string }, []>('SELECT dedupe_key FROM alerts')
			.all()
			.map((r) => r.dedupe_key),
	)

	// Telegram-only triggers, deduplicated across restarts (pruned after a week).
	db.run('DELETE FROM telegram_sent WHERE ts < ?', [Date.now() - 7 * 86_400_000])
	const telegramKeys = new Set(
		db
			.query<{ key: string }, []>('SELECT key FROM telegram_sent')
			.all()
			.map((r) => r.key),
	)
	const markTelegram = db.query('INSERT OR IGNORE INTO telegram_sent (key, ts) VALUES (?, ?)')
	// Last seen curve progress per pool: a level counts as crossed only when a swap moves the
	// pool from below it to at/above it (no burst of stale "crossings" after a restart).
	const lastProgress = new Map<string, number>()

	const insert = db.query<{ id: number }, Record<string, string | number | null>>(`
		INSERT INTO alerts (dedupe_key, type, pool, symbol, detail, payload, ts)
		VALUES ($key, $type, $pool, $symbol, $detail, $payload, $ts)
		ON CONFLICT (dedupe_key) DO NOTHING
		RETURNING id
	`)
	const saveDeliveries = db.query('UPDATE alerts SET deliveries = $deliveries WHERE id = $id')
	const recent = db.query<Row, []>('SELECT * FROM alerts ORDER BY ts DESC, id DESC LIMIT 50')
	const fired1h = db.query<{ n: number }, [number]>(
		'SELECT count(*) AS n FROM alerts WHERE ts >= ?',
	)
	const delivered = db.query<{ n: number }, [number]>(`
		SELECT count(*) AS n FROM alerts, json_each(alerts.deliveries) d
		WHERE alerts.ts >= ? AND json_extract(d.value, '$.ok') = 1
	`)

	// Errors may echo the request URL; never let the webhook URL, secret or bot token leak.
	const scrub = (message: string) =>
		secrets.reduce((m, s) => m.split(s).join('<redacted>'), message)

	const send = async (
		dest: AlertDelivery['dest'],
		url: string,
		body: string,
		headers: Record<string, string>,
	): Promise<AlertDelivery> => {
		const startedAt = performance.now()
		let status: number | null = null
		let error: string | undefined
		let attempts = 0
		while (attempts < MAX_ATTEMPTS) {
			attempts++
			try {
				const res = await fetch(url, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'user-agent': 'dbc-radar-alerts',
						...headers,
					},
					body,
					signal: AbortSignal.timeout(TIMEOUT_MS),
				})
				status = res.status
				error = res.ok ? undefined : `HTTP ${res.status}`
				if (res.ok || (res.status < 500 && res.status !== 429)) break
			} catch (e) {
				status = null
				error = scrub((e as Error).message)
			}
			if (attempts < MAX_ATTEMPTS) await Bun.sleep(BACKOFF_MS * 2 ** (attempts - 1))
		}
		return {
			dest,
			ok: status !== null && status >= 200 && status < 300,
			status,
			ms: Math.round(performance.now() - startedAt),
			attempts,
			...(error ? { error } : {}),
		}
	}

	const toWebhook = (payload: AlertPayload) => {
		if (!cfg.webhookUrl) return null
		const body = JSON.stringify(payload)
		const headers: Record<string, string> = {}
		if (cfg.webhookSecret)
			headers['x-dbc-signature'] = `sha256=${new Bun.CryptoHasher('sha256', cfg.webhookSecret)
				.update(body)
				.digest('hex')}`
		return send('webhook', cfg.webhookUrl, body, headers)
	}

	const telegramAlert = (
		kind: AlertType,
		summary: PoolSummary,
		detail: string,
		extra: { level?: number; flag?: RiskFlag } = {},
	): TelegramAlert => ({
		kind,
		...extra,
		pool: summary.pool,
		symbol: summary.symbol,
		name: summary.name,
		detail,
		progress: summary.progress,
		riskScore: summary.risk.score,
		url: `${config.publicUrl}/pool/${summary.pool}`,
	})

	const curveDetail = (level: number, summary: PoolSummary) =>
		`crossed ${Math.round(level * 100)}% · vol 5m ${usd(summary.volume5m)}`
	const gradDetail = (ttg: number | null) =>
		ttg === null ? 'curve filled' : `curve filled in ${duration(ttg)}`
	const riskDetail = (flag: RiskFlag, summary: PoolSummary) =>
		`${FLAG_LABELS[flag]} · risk ${summary.risk.score}`

	const fire = (type: AlertType, summary: PoolSummary, detail: string, flag?: RiskFlag) => {
		const ts = Date.now()
		const payload: AlertPayload = {
			type,
			pool: summary.pool,
			mint: summary.baseMint,
			symbol: summary.symbol,
			name: summary.name,
			curveProgress: summary.progress,
			...(summary.timeToGraduateMs !== null && type === 'graduated'
				? { timeToGraduateMs: summary.timeToGraduateMs }
				: {}),
			riskScore: summary.risk.score,
			...(flag ? { flag } : {}),
			url: `${config.publicUrl}/pool/${summary.pool}`,
			ts,
		}
		const row = insert.get({
			key: keyOf(type, summary.pool, flag),
			type,
			pool: summary.pool,
			symbol: summary.symbol,
			detail,
			payload: JSON.stringify(payload),
			ts,
		})
		if (!row) return // already fired for this pool
		// Visitors see it right away; deliveries may still be pending (they land in /api/alerts).
		publish({
			type: 'alert',
			alert: {
				id: row.id,
				type,
				pool: summary.pool,
				symbol: summary.symbol,
				detail,
				payload,
				deliveries: [],
				ts,
			},
		})
		const pending = [
			toWebhook(payload),
			telegram?.notify(
				telegramAlert(type, summary, detail, {
					flag,
					level: type === 'curve' ? cfg.curveThreshold : undefined,
				}),
				true,
			) ?? null,
		].filter((p): p is Promise<AlertDelivery | null> => p !== null)
		if (pending.length === 0) return
		Promise.all(pending).then((results) => {
			const deliveries = results.filter((d): d is AlertDelivery => d !== null)
			if (deliveries.length === 0) return
			saveDeliveries.run({ id: row.id, deliveries: JSON.stringify(deliveries) })
			for (const d of deliveries)
				if (!d.ok) console.warn(`[alerts] ${d.dest} delivery failed: ${d.error ?? d.status}`)
		})
	}

	/** Telegram-only trigger: dedupe by key, then notify matching subscribers after the commit. */
	const telegramOnly = (
		key: string,
		pool: string,
		match: Pick<TelegramAlert, 'kind' | 'level' | 'flag'>,
		build: (summary: PoolSummary) => TelegramAlert | null,
	) => {
		if (!telegram || telegramKeys.has(key)) return
		telegramKeys.add(key)
		markTelegram.run(key, Date.now())
		if (!telegram.wants(match)) return
		queueMicrotask(() => {
			const summary = metrics.getSummary(pool)
			const alert = summary && build(summary)
			if (alert) void telegram.notify(alert, false)
		})
	}

	const onTelegramEvent = (event: LiveEvent) => {
		if (!telegram) return
		if (event.type === 'trade') {
			if (event.progress === null) return
			const prev = lastProgress.get(event.pool)
			lastProgress.set(event.pool, event.progress)
			if (prev === undefined || event.progress >= 1) return
			for (const level of CURVE_LEVELS) {
				// The site-wide rule already covers its own level (and records the delivery).
				if (curveEnabled && Math.abs(level - cfg.curveThreshold) < 1e-6) continue
				if (prev >= level || event.progress < level) continue
				telegramOnly(`curve:${level}:${event.pool}`, event.pool, { kind: 'curve', level }, (s) =>
					telegramAlert('curve', s, curveDetail(level, s), { level }),
				)
			}
		} else if (event.type === 'graduated' && !cfg.graduations) {
			telegramOnly(`graduated:${event.pool}`, event.pool, { kind: 'graduated' }, (s) =>
				s.timeToGraduateMs !== null && s.timeToGraduateMs < cfg.skipFastGraduationsMs
					? null
					: telegramAlert('graduated', s, gradDetail(s.timeToGraduateMs)),
			)
		} else if (event.type === 'risk' && !riskFlags.includes(event.flag)) {
			const flag = event.flag
			telegramOnly(`risk:${event.pool}:${flag}`, event.pool, { kind: 'risk', flag }, (s) =>
				telegramAlert('risk', s, riskDetail(flag, s), { flag }),
			)
		}
	}

	const onEvent = (event: LiveEvent) => {
		onTelegramEvent(event)
		if (event.type === 'trade') {
			if (!curveEnabled || event.progress === null) return
			// A swap that fills the curve outright is reported as a graduation instead.
			if (event.progress < cfg.curveThreshold || event.progress >= 1) return
		} else if (event.type === 'graduated') {
			if (!cfg.graduations) return
		} else if (event.type === 'risk') {
			if (!riskFlags.includes(event.flag)) return
		} else return
		const type: AlertType =
			event.type === 'trade' ? 'curve' : event.type === 'graduated' ? 'graduated' : 'risk'
		const key = keyOf(type, event.pool, event.type === 'risk' ? event.flag : undefined)
		if (firedKeys.has(key)) return
		firedKeys.add(key)

		// Live events are emitted inside the ingest transaction: evaluate after the commit.
		queueMicrotask(() => {
			const summary = metrics.getSummary(event.pool)
			if (!summary) return
			if (event.type === 'trade') {
				fire('curve', summary, curveDetail(cfg.curveThreshold, summary))
			} else if (event.type === 'graduated') {
				const ttg = summary.timeToGraduateMs
				if (ttg !== null && ttg < cfg.skipFastGraduationsMs) return
				fire('graduated', summary, gradDetail(ttg))
			} else if (event.type === 'risk') {
				fire('risk', summary, riskDetail(event.flag, summary), event.flag)
			}
		})
	}

	const lastStatus = (rows: AlertFired[], dest: AlertDelivery['dest']) => {
		for (const row of rows) {
			const d = row.deliveries.find((x) => x.dest === dest)
			if (d) return d.status
		}
		return null
	}

	return {
		onEvent,
		start: () => telegram?.start(),
		stop: () => telegram?.stop(),
		state(): AlertsState {
			const now = Date.now()
			const rows = recent.all().map(toFired)
			const rules = {
				curve: { enabled: curveEnabled, threshold: cfg.curveThreshold },
				graduated: { enabled: cfg.graduations, skipFastMs: cfg.skipFastGraduationsMs },
				risk: { enabled: riskFlags.length > 0, flags: riskFlags },
			}
			return {
				rules,
				destinations: {
					webhook: {
						enabled: Boolean(cfg.webhookUrl),
						host: hostOf(cfg.webhookUrl),
						signed: Boolean(cfg.webhookSecret),
						lastStatus: lastStatus(rows, 'webhook'),
					},
					telegram: {
						enabled: telegram !== null,
						...(telegram?.state() ?? { botUsername: null, subscribers: 0, polling: false }),
						lastStatus: lastStatus(rows, 'telegram'),
					},
				},
				stats: {
					fired1h: fired1h.get(now - 3_600_000)?.n ?? 0,
					delivered: delivered.get(now - 86_400_000)?.n ?? 0,
					activeRules: Object.values(rules).filter((r) => r.enabled).length,
				},
				recent: rows,
			}
		},
		describe() {
			const dests = [
				cfg.webhookUrl && `webhook (${hostOf(cfg.webhookUrl)})`,
				telegram &&
					`telegram bot${cfg.telegramChatId ? ' + fixed chat' : ''}${cfg.telegramPolling ? '' : ' (polling off)'}`,
			]
			return `rules curve=${curveEnabled ? cfg.curveThreshold : 'off'} graduated=${cfg.graduations} flags=${riskFlags.join(',') || 'off'} · destinations: ${dests.filter(Boolean).join(', ') || 'none (recording only)'}`
		},
	}
}

export type Alerts = ReturnType<typeof createAlerts>
