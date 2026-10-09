/*
 * Sets up the bot's public profile: name, descriptions, command menu and profile photo.
 * Idempotent (each field is only written when it differs, so it won't trip Telegram's
 * rate limits). Uses TELEGRAM_BOT_TOKEN from the environment and never prints it.
 *
 *   cd apps/indexer && bun --env-file=.env scripts/telegram-profile.ts [--photo]
 *
 * `--photo` also uploads assets/telegram/avatar.jpg as the profile photo (Telegram keeps a
 * history of photos, so it's opt-in). The description picture (the image above the Start
 * button) has no Bot API method: set assets/telegram/descpic.png with @BotFather →
 * /setdescriptionpic.
 */
import { join } from 'node:path'
import { BOT_COMMANDS } from '../src/telegram'

const token = process.env.TELEGRAM_BOT_TOKEN
if (!token) {
	console.error('TELEGRAM_BOT_TOKEN is not set')
	process.exit(1)
}

const NAME = 'DBC Radar'
const SHORT =
	'Live Meteora DBC launch alerts on Solana: curve crossings, graduations and rug flags, straight from the chain.'
const DESCRIPTION = [
	'DBC Radar watches every Meteora Dynamic Bonding Curve launch on Solana mainnet, live.',
	'',
	'Get a message when a pool crosses your curve level (50–90%), graduates to DAMM v2, or raises a risk flag you pick: creator sold, whale buyer, wash trading and more.',
	'',
	'/start subscribe · /threshold curve level · /flags risk flags · /grads graduations · /stop',
	'',
	'https://pep3marquez.com/dbc-radar',
].join('\n')

const api = async (method: string, body: object | FormData) => {
	const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
		method: 'POST',
		...(body instanceof FormData
			? { body }
			: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
	})
	const json = (await res.json().catch(() => ({}))) as {
		ok?: boolean
		result?: unknown
		description?: string
	}
	if (!json.ok) throw new Error(`${method}: HTTP ${res.status} ${json.description ?? ''}`)
	return json.result
}

const ensure = async (
	label: string,
	current: string,
	wanted: string,
	set: () => Promise<unknown>,
) => {
	if (current === wanted) return console.log(`= ${label} already set`)
	await set()
	console.log(`✓ ${label} updated`)
}

if (SHORT.length > 120 || DESCRIPTION.length > 512) throw new Error('description too long')

const me = (await api('getMe', {})) as { username: string }
console.log(`bot @${me.username}`)

const name = ((await api('getMyName', {})) as { name: string }).name
await ensure('name', name, NAME, () => api('setMyName', { name: NAME }))

const short = ((await api('getMyShortDescription', {})) as { short_description: string })
	.short_description
await ensure('short description', short, SHORT, () =>
	api('setMyShortDescription', { short_description: SHORT }),
)

const desc = ((await api('getMyDescription', {})) as { description: string }).description
await ensure('description', desc, DESCRIPTION, () =>
	api('setMyDescription', { description: DESCRIPTION }),
)

const commands = (await api('getMyCommands', {})) as { command: string; description: string }[]
await ensure('commands', JSON.stringify(commands), JSON.stringify(BOT_COMMANDS), () =>
	api('setMyCommands', { commands: BOT_COMMANDS }),
)

if (process.argv.includes('--photo')) {
	const file = Bun.file(join(import.meta.dir, '../assets/telegram/avatar.jpg'))
	const form = new FormData()
	form.append('photo', JSON.stringify({ type: 'static', photo: 'attach://avatar' }))
	form.append('avatar', file, 'avatar.jpg')
	await api('setMyProfilePhoto', form)
	console.log('✓ profile photo uploaded')
}
