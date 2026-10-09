import type { AlertDelivery, RiskFlag } from './domain/api'
import type { Db } from './store/db'

/*
 * Telegram subscriber bot. Anyone can /start it in a private chat and tune their own alerts
 * (curve level, graduations, risk flags). Commands arrive by long-polling getUpdates (offset
 * kept in SQLite so a restart never re-processes an update); only one process may poll a bot,
 * so HTTP 409 means another instance is polling and we back off quietly.
 *
 * Outgoing messages share one queue: ≤ 25 msg/s overall and ≤ 1 msg/s per chat, honouring
 * 429 `retry_after`; a 403 (bot blocked / account deleted) deactivates the subscriber.
 * The bot token only ever appears in request URLs, which are never logged.
 */

/** Command menu (also set by scripts/telegram-profile.ts). */
export const BOT_COMMANDS = [
	{ command: 'start', description: 'Subscribe to DBC Radar alerts' },
	{ command: 'status', description: 'Your alert settings' },
	{ command: 'threshold', description: 'Curve level: 50, 70, 80 or 90' },
	{ command: 'flags', description: 'Pick risk flags' },
	{ command: 'grads', description: 'Graduation alerts on or off' },
	{ command: 'stop', description: 'Unsubscribe' },
	{ command: 'help', description: 'Commands' },
]

export const CURVE_LEVELS = [0.5, 0.7, 0.8, 0.9] as const

export const RISK_FLAGS: RiskFlag[] = [
	'creator_sold',
	'whale_buyer',
	'concentrated',
	'wash_trading',
	'dumping',
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

const FLAG_WEIGHTS: Record<RiskFlag, number> = {
	creator_sold: 40,
	whale_buyer: 25,
	concentrated: 25,
	wash_trading: 20,
	dumping: 15,
	fresh_wallets: 15,
}

export type TelegramPrefs = { threshold: number; grads: boolean; flags: RiskFlag[] }

const DEFAULT_PREFS: TelegramPrefs = { threshold: 0.8, grads: true, flags: ['creator_sold'] }

/** What a subscriber can match on, plus the message content. */
export type TelegramAlert = {
	kind: 'curve' | 'graduated' | 'risk'
	/** Curve level that was crossed (curve alerts). */
	level?: number
	flag?: RiskFlag
	pool: string
	symbol: string | null
	name: string | null
	detail: string
	progress: number | null
	riskScore: number
	url: string
}

const API = 'https://api.telegram.org'
const POLL_TIMEOUT_S = 25
const GLOBAL_INTERVAL_MS = 40 // 25 msg/s
const PER_CHAT_INTERVAL_MS = 1000
const COMMAND_INTERVAL_MS = 1000
const CONFLICT_BACKOFF_MS = 60_000

// Bidi overrides / isolates and zero-width marks: token names are attacker-controlled.
const BIDI = /[‎‏‪-‮⁦-⁩]/g
const clean = (s: string, max = 40) => {
	const t = s.replace(BIDI, '').trim()
	return t.length > max ? `${t.slice(0, max - 1)}…` : t
}
const esc = (s: string) =>
	s.replace(
		/[&<>"]/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string,
	)

const pct = (v: number) => `${Math.round(v * 100)}%`

type Subscriber = { chat_id: number; prefs: string; active: number }
type Button = { text: string; callback_data: string }
type Keyboard = { inline_keyboard: Button[][] }
type Update = {
	update_id: number
	message?: {
		message_id: number
		chat: { id: number; type: string; first_name?: string; username?: string }
		text?: string
	}
	callback_query?: {
		id: string
		data?: string
		message?: { message_id: number; chat: { id: number; type: string } }
		from: { id: number }
	}
}
type Reply = {
	ok: boolean
	status: number | null
	result?: unknown
	retryAfter?: number
	description?: string
}

const parsePrefs = (raw: string): TelegramPrefs => {
	try {
		const p = JSON.parse(raw) as Partial<TelegramPrefs>
		return {
			threshold: CURVE_LEVELS.includes(p.threshold as (typeof CURVE_LEVELS)[number])
				? (p.threshold as number)
				: DEFAULT_PREFS.threshold,
			grads: typeof p.grads === 'boolean' ? p.grads : DEFAULT_PREFS.grads,
			flags: Array.isArray(p.flags)
				? p.flags.filter((f) => RISK_FLAGS.includes(f))
				: DEFAULT_PREFS.flags,
		}
	} catch {
		return DEFAULT_PREFS
	}
}

export const matches = (prefs: TelegramPrefs, alert: TelegramAlert) =>
	alert.kind === 'curve'
		? alert.level != null && Math.abs(alert.level - prefs.threshold) < 1e-6
		: alert.kind === 'graduated'
			? prefs.grads
			: alert.flag != null && prefs.flags.includes(alert.flag)

export const formatAlert = (alert: TelegramAlert) => {
	const tag =
		alert.kind === 'curve'
			? `◎ CURVE ${pct(alert.level ?? 0)}`
			: alert.kind === 'graduated'
				? '● GRADUATED'
				: `◆ ${(alert.flag ? FLAG_LABELS[alert.flag] : 'risk flag').toUpperCase()}`
	const symbol = esc(clean(alert.symbol ?? `${alert.pool.slice(0, 4)}…${alert.pool.slice(-4)}`, 24))
	const name = alert.name ? ` · ${esc(clean(alert.name))}` : ''
	const stats = [
		alert.progress != null ? `curve ${pct(Math.min(1, alert.progress))}` : null,
		`risk ${alert.riskScore}`,
	]
		.filter(Boolean)
		.join(' · ')
	return [
		`<b>${esc(tag)}</b>  <b>${symbol}</b>${name}`,
		esc(clean(alert.detail, 120)),
		stats,
		`<a href="${esc(alert.url)}">Open on DBC Radar →</a>`,
	].join('\n')
}

export const createTelegramBot = (
	db: Db,
	opts: { token: string; polling: boolean; fixedChatId: string | null; publicUrl: string },
) => {
	const call = async (method: string, body: object, timeoutMs = 10_000): Promise<Reply> => {
		try {
			const res = await fetch(`${API}/bot${opts.token}/${method}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			})
			const json = (await res.json().catch(() => null)) as {
				ok?: boolean
				result?: unknown
				description?: string
				parameters?: { retry_after?: number }
			} | null
			return {
				ok: res.ok && json?.ok === true,
				status: res.status,
				result: json?.result,
				retryAfter: json?.parameters?.retry_after,
				description: json?.description,
			}
		} catch (e) {
			// fetch errors can echo the URL (and with it the token): keep only the error name.
			return { ok: false, status: null, description: (e as Error).name }
		}
	}

	const getState = db.query<{ value: string }, [string]>(
		'SELECT value FROM telegram_state WHERE key = ?',
	)
	const setState = db.query(
		'INSERT INTO telegram_state (key, value) VALUES ($key, $value) ON CONFLICT (key) DO UPDATE SET value = $value',
	)
	const getSub = db.query<Subscriber, [number]>(
		'SELECT * FROM telegram_subscribers WHERE chat_id = ?',
	)
	const activeSubs = db.query<Subscriber, []>('SELECT * FROM telegram_subscribers WHERE active = 1')
	const countActive = db.query<{ n: number }, []>(
		'SELECT count(*) AS n FROM telegram_subscribers WHERE active = 1',
	)
	const upsertSub = db.query(`
		INSERT INTO telegram_subscribers (chat_id, name, prefs, active, created_at, updated_at)
		VALUES ($chat, $name, $prefs, 1, $now, $now)
		ON CONFLICT (chat_id) DO UPDATE SET active = 1, name = $name, updated_at = $now
	`)
	const savePrefs = db.query(
		'UPDATE telegram_subscribers SET prefs = $prefs, updated_at = $now WHERE chat_id = $chat',
	)
	const setActive = db.query(
		'UPDATE telegram_subscribers SET active = $active, updated_at = $now WHERE chat_id = $chat',
	)

	let username: string | null = null
	let polling = false
	let running = false

	/* ───────────── Outgoing queue ───────────── */

	type Job = {
		chat: string | number
		body: object
		resolve: (r: Reply & { ms: number }) => void
		at: number
	}
	const queue: Job[] = []
	const chatReadyAt = new Map<string, number>()
	let pausedUntil = 0
	let pumping = false

	const pump = async () => {
		if (pumping) return
		pumping = true
		while (queue.length) {
			const now = Date.now()
			if (now < pausedUntil) {
				await Bun.sleep(pausedUntil - now)
				continue
			}
			const i = queue.findIndex((j) => (chatReadyAt.get(String(j.chat)) ?? 0) <= now)
			if (i === -1) {
				const next = Math.min(...queue.map((j) => chatReadyAt.get(String(j.chat)) ?? 0))
				await Bun.sleep(Math.max(GLOBAL_INTERVAL_MS, next - now))
				continue
			}
			const [job] = queue.splice(i, 1)
			chatReadyAt.set(String(job.chat), now + PER_CHAT_INTERVAL_MS)
			const reply = await call('sendMessage', { chat_id: job.chat, ...job.body })
			if (reply.status === 429) {
				pausedUntil = Date.now() + (reply.retryAfter ?? 5) * 1000
				queue.unshift(job)
				continue
			}
			if (reply.status === 403 && typeof job.chat === 'number') {
				setActive.run({ chat: job.chat, active: 0, now: Date.now() })
				console.warn('[telegram] a subscriber blocked the bot: marked inactive')
			}
			job.resolve({ ...reply, ms: Date.now() - job.at })
			await Bun.sleep(GLOBAL_INTERVAL_MS)
		}
		pumping = false
	}

	const send = (chat: string | number, text: string, extra: object = {}) =>
		new Promise<Reply & { ms: number }>((resolve) => {
			queue.push({
				chat,
				body: { text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra },
				resolve,
				at: Date.now(),
			})
			void pump()
		})

	/* ───────────── Settings UI ───────────── */

	const settingsText = (prefs: TelegramPrefs, intro = '') =>
		[
			intro,
			'<b>Your DBC Radar alerts</b>',
			`◎ Curve crosses <b>${pct(prefs.threshold)}</b>`,
			`● Graduations: <b>${prefs.grads ? 'on' : 'off'}</b> (skips likely bundles under 1 min)`,
			`◆ Risk flags: <b>${prefs.flags.length ? prefs.flags.map((f) => FLAG_LABELS[f]).join(', ') : 'none'}</b>`,
			'',
			`All alerts: ${esc(`${opts.publicUrl}/alerts`)}`,
		]
			.filter((l, i) => i > 0 || l)
			.join('\n')

	const settingsKeyboard = (prefs: TelegramPrefs): Keyboard => ({
		inline_keyboard: [
			CURVE_LEVELS.map((l) => ({
				text: `${Math.abs(l - prefs.threshold) < 1e-6 ? '● ' : ''}${pct(l)}`,
				callback_data: `t:${Math.round(l * 100)}`,
			})),
			[
				{ text: `Graduations: ${prefs.grads ? 'on' : 'off'}`, callback_data: 'g' },
				{ text: `Risk flags (${prefs.flags.length}) →`, callback_data: 'f' },
			],
		],
	})

	const flagsText = (prefs: TelegramPrefs) =>
		`<b>Risk flags</b>\nTap to toggle. You get a message when a pool raises a selected flag.\nSelected: <b>${prefs.flags.length ? prefs.flags.map((f) => FLAG_LABELS[f]).join(', ') : 'none'}</b>`

	const flagsKeyboard = (prefs: TelegramPrefs): Keyboard => {
		const buttons = RISK_FLAGS.map((f) => ({
			text: `${prefs.flags.includes(f) ? '◆' : '◇'} ${FLAG_LABELS[f]} +${FLAG_WEIGHTS[f]}`,
			callback_data: `f:${f}`,
		}))
		return {
			inline_keyboard: [
				buttons.slice(0, 2),
				buttons.slice(2, 4),
				buttons.slice(4, 6),
				[{ text: '← Back to settings', callback_data: 'b' }],
			],
		}
	}

	const HELP = [
		'<b>DBC Radar bot</b> · live Meteora DBC alerts',
		'',
		'/start subscribe',
		'/status your settings',
		'/threshold 50|70|80|90 curve level',
		'/flags pick risk flags',
		'/grads on|off graduations',
		'/stop unsubscribe',
	].join('\n')

	/* ───────────── Commands ───────────── */

	const lastCommandAt = new Map<number, number>()
	const limited = (chat: number) => {
		const now = Date.now()
		if (now - (lastCommandAt.get(chat) ?? 0) < COMMAND_INTERVAL_MS) return true
		lastCommandAt.set(chat, now)
		return false
	}

	const subscriber = (chat: number) => {
		const row = getSub.get(chat)
		return row?.active ? parsePrefs(row.prefs) : null
	}
	const update = (chat: number, prefs: TelegramPrefs) =>
		savePrefs.run({ chat, prefs: JSON.stringify(prefs), now: Date.now() })

	const NOT_SUBSCRIBED = 'You are not subscribed. Send /start to get alerts.'

	const onMessage = async (msg: NonNullable<Update['message']>) => {
		if (msg.chat.type !== 'private' || !msg.text) return
		const chat = msg.chat.id
		if (limited(chat)) return
		const [rawCmd, arg = ''] = msg.text.trim().split(/\s+/, 2)
		const cmd = rawCmd.toLowerCase().replace(/@.*$/, '')
		if (cmd === '/start') {
			const before = getSub.get(chat)
			upsertSub.run({
				chat,
				name:
					clean(msg.chat.username ? `@${msg.chat.username}` : (msg.chat.first_name ?? ''), 64) ||
					null,
				prefs: JSON.stringify(DEFAULT_PREFS),
				now: Date.now(),
			})
			const prefs = subscriber(chat) ?? DEFAULT_PREFS
			const intro = before?.active
				? 'You are already subscribed.\n'
				: before
					? 'Welcome back: alerts are on again with your previous settings.\n'
					: 'Subscribed. You will get a message when a Meteora DBC pool crosses your curve level, graduates, or raises a risk flag you picked.\n'
			await send(chat, settingsText(prefs, intro), { reply_markup: settingsKeyboard(prefs) })
			return
		}
		if (cmd === '/help') {
			await send(chat, HELP)
			return
		}
		const prefs = subscriber(chat)
		if (!prefs) {
			await send(chat, NOT_SUBSCRIBED)
			return
		}
		if (cmd === '/stop') {
			setActive.run({ chat, active: 0, now: Date.now() })
			await send(chat, 'Unsubscribed: no more alerts. Send /start any time to come back.')
		} else if (cmd === '/status') {
			await send(chat, settingsText(prefs), { reply_markup: settingsKeyboard(prefs) })
		} else if (cmd === '/threshold') {
			const level = Number(arg.replace('%', '')) / 100
			if (CURVE_LEVELS.some((l) => Math.abs(l - level) < 1e-6)) {
				const next = { ...prefs, threshold: level }
				update(chat, next)
				await send(chat, settingsText(next, `Curve level set to ${pct(level)}.\n`), {
					reply_markup: settingsKeyboard(next),
				})
			} else {
				await send(chat, 'Pick a curve level: 50%, 70%, 80% or 90%.', {
					reply_markup: settingsKeyboard(prefs),
				})
			}
		} else if (cmd === '/flags') {
			await send(chat, flagsText(prefs), { reply_markup: flagsKeyboard(prefs) })
		} else if (cmd === '/grads') {
			const on =
				arg.toLowerCase() === 'on' ? true : arg.toLowerCase() === 'off' ? false : !prefs.grads
			const next = { ...prefs, grads: on }
			update(chat, next)
			await send(chat, settingsText(next, `Graduations ${on ? 'on' : 'off'}.\n`), {
				reply_markup: settingsKeyboard(next),
			})
		} else {
			await send(chat, HELP)
		}
	}

	const onCallback = async (cb: NonNullable<Update['callback_query']>) => {
		const msg = cb.message
		if (!msg || msg.chat.type !== 'private') return
		const chat = msg.chat.id
		if (limited(chat)) {
			await call('answerCallbackQuery', {
				callback_query_id: cb.id,
				text: 'One tap per second, please.',
			})
			return
		}
		const prefs = subscriber(chat)
		if (!prefs) {
			await call('answerCallbackQuery', { callback_query_id: cb.id, text: NOT_SUBSCRIBED })
			return
		}
		const data = cb.data ?? ''
		let next = prefs
		let view: 'settings' | 'flags' = 'settings'
		let note = ''
		if (data.startsWith('t:')) {
			const level = Number(data.slice(2)) / 100
			if (CURVE_LEVELS.some((l) => Math.abs(l - level) < 1e-6))
				next = { ...prefs, threshold: level }
			note = `Curve level ${pct(next.threshold)}`
		} else if (data === 'g') {
			next = { ...prefs, grads: !prefs.grads }
			note = `Graduations ${next.grads ? 'on' : 'off'}`
		} else if (data === 'f') {
			view = 'flags'
		} else if (data.startsWith('f:')) {
			const flag = data.slice(2) as RiskFlag
			if (RISK_FLAGS.includes(flag))
				next = {
					...prefs,
					flags: prefs.flags.includes(flag)
						? prefs.flags.filter((f) => f !== flag)
						: [...prefs.flags, flag],
				}
			view = 'flags'
			note = `${FLAG_LABELS[flag] ?? 'flag'} ${next.flags.includes(flag) ? 'on' : 'off'}`
		}
		if (next !== prefs) update(chat, next)
		await call('answerCallbackQuery', { callback_query_id: cb.id, ...(note ? { text: note } : {}) })
		await call('editMessageText', {
			chat_id: chat,
			message_id: msg.message_id,
			text: view === 'flags' ? flagsText(next) : settingsText(next),
			parse_mode: 'HTML',
			link_preview_options: { is_disabled: true },
			reply_markup: view === 'flags' ? flagsKeyboard(next) : settingsKeyboard(next),
		})
	}

	const handle = async (u: Update) => {
		try {
			if (u.message) await onMessage(u.message)
			else if (u.callback_query) await onCallback(u.callback_query)
		} catch (e) {
			console.warn(`[telegram] failed to handle update ${u.update_id}: ${(e as Error).message}`)
		}
	}

	/* ───────────── Polling ───────────── */

	const poll = async () => {
		let offset = Number(getState.get('offset')?.value ?? 0)
		let conflictLogged = false
		while (running) {
			const reply = await call(
				'getUpdates',
				{ offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message', 'callback_query'] },
				(POLL_TIMEOUT_S + 10) * 1000,
			)
			if (!running) break
			if (reply.status === 409) {
				polling = false
				if (!conflictLogged)
					console.warn(
						`[telegram] another process is polling @${username ?? 'the bot'} (HTTP 409); commands are handled there. Retrying every ${CONFLICT_BACKOFF_MS / 1000}s`,
					)
				conflictLogged = true
				await Bun.sleep(CONFLICT_BACKOFF_MS)
				continue
			}
			if (reply.status === 401 || reply.status === 404) {
				polling = false
				console.warn('[telegram] bot token rejected (HTTP 401): polling stopped')
				return
			}
			if (!reply.ok) {
				polling = false
				await Bun.sleep(reply.status === 429 ? (reply.retryAfter ?? 5) * 1000 : 5000)
				continue
			}
			if (!polling) console.log(`[telegram] polling commands for @${username ?? '?'}`)
			polling = true
			conflictLogged = false
			const updates = (reply.result as Update[]) ?? []
			for (const u of updates) {
				await handle(u)
				offset = u.update_id + 1
				setState.run({ key: 'offset', value: String(offset) })
			}
		}
		polling = false
	}

	/* ───────────── Public API ───────────── */

	return {
		async start() {
			const me = await call('getMe', {})
			username = (me.result as { username?: string } | undefined)?.username ?? null
			if (!me.ok) console.warn(`[telegram] getMe failed (${me.status ?? me.description})`)
			await call('setMyCommands', { commands: BOT_COMMANDS })
			if (opts.polling && me.ok) {
				running = true
				void poll()
			}
		},
		stop() {
			running = false
		},
		/** Processes one Bot API Update (what polling does for each update it receives). */
		handleUpdate: handle,
		/**
		 * Sends an alert to every active subscriber whose prefs match (and to the fixed chat when
		 * `includeFixed`). Resolves to one aggregate delivery, or null when nobody was targeted.
		 */
		async notify(alert: TelegramAlert, includeFixed: boolean): Promise<AlertDelivery | null> {
			const targets: (string | number)[] = activeSubs
				.all()
				.filter((s) => matches(parsePrefs(s.prefs), alert))
				.map((s) => s.chat_id)
			if (includeFixed && opts.fixedChatId && !targets.some((t) => String(t) === opts.fixedChatId))
				targets.push(opts.fixedChatId)
			if (targets.length === 0) return null
			const text = formatAlert(alert)
			const results = await Promise.all(targets.map((chat) => send(chat, text)))
			const sent = results.filter((r) => r.ok).length
			const failed = results.length - sent
			const last = results.find((r) => !r.ok) ?? results[results.length - 1]
			return {
				dest: 'telegram',
				ok: sent > 0,
				status: last.status,
				ms: Math.max(...results.map((r) => r.ms)),
				attempts: results.length,
				sent,
				failed,
				...(failed > 0 ? { error: last.description ?? `HTTP ${last.status}` } : {}),
			}
		},
		/** True when some active subscriber would receive this kind of alert (cheap pre-check). */
		wants(alert: Pick<TelegramAlert, 'kind' | 'level' | 'flag'>) {
			return activeSubs.all().some((s) => matches(parsePrefs(s.prefs), alert as TelegramAlert))
		},
		state() {
			return { botUsername: username, subscribers: countActive.get()?.n ?? 0, polling }
		},
	}
}

export type TelegramBot = ReturnType<typeof createTelegramBot>
