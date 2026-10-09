// Prepares a local dev environment: dependencies, apps/indexer/.env and the data dir.
// Safe to re-run: it never overwrites an existing key without asking.
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const envPath = join(root, 'apps/indexer/.env')
const examplePath = join(root, 'apps/indexer/.env.example')
const interactive = process.stdin.isTTY

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const ok = (s: string) => console.log(`\x1b[32m✔\x1b[0m ${s}`)
const warn = (s: string) => console.log(`\x1b[33m!\x1b[0m ${s}`)
const step = (s: string) => console.log(`\n${bold(s)}`)

const checkKey = async (key: string): Promise<'valid' | 'invalid' | 'unreachable'> => {
	const url = `${process.env.SOLAMI_DATA_API_URL ?? 'https://api.solami.dev'}/data/token/metadata?chain=solana&address=So11111111111111111111111111111111111111112`
	try {
		const res = await fetch(url, {
			headers: { 'x-api-key': key },
			signal: AbortSignal.timeout(10_000),
		})
		if (res.ok) return 'valid'
		return res.status === 401 || res.status === 403 ? 'invalid' : 'unreachable'
	} catch {
		return 'unreachable'
	}
}

const readKey = (env: string) => env.match(/^SOLAMI_API_KEY=(.*)$/m)?.[1]?.trim() ?? ''

const writeKey = (env: string, key: string) =>
	/^SOLAMI_API_KEY=/m.test(env)
		? env.replace(/^SOLAMI_API_KEY=.*$/m, `SOLAMI_API_KEY=${key}`)
		: `SOLAMI_API_KEY=${key}\n${env}`

console.log(bold('DBC Radar · dev setup'))

step('1. Dependencies')
const [major, minor] = Bun.version.split('.').map(Number)
if (major < 1 || (major === 1 && minor < 2))
	warn(`Bun ${Bun.version} detected; 1.2+ is recommended`)
else ok(`Bun ${Bun.version}`)
const install = Bun.spawnSync([process.execPath, 'install'], {
	cwd: root,
	stdio: ['inherit', 'inherit', 'inherit'],
})
if (install.exitCode !== 0) process.exit(install.exitCode ?? 1)
ok('Dependencies installed')

step('2. Indexer environment (apps/indexer/.env)')
let env = existsSync(envPath) ? await Bun.file(envPath).text() : await Bun.file(examplePath).text()
if (existsSync(envPath)) ok('apps/indexer/.env already exists')
else ok('Created apps/indexer/.env from .env.example')

let key = readKey(env)
if (key && interactive) {
	const answer = prompt('A Solami API key is already configured. Replace it? [y/N]')
	if (answer?.trim().toLowerCase() === 'y') key = ''
}
if (!key && interactive) {
	console.log(
		dim(
			'  The key powers the gRPC stream, Blur and the Data API. Get one at https://solami.dev\n  Leave it empty to use the public Solana RPC (lossy, rate limited).',
		),
	)
	key = prompt('Solami API key:')?.trim() ?? ''
}
env = writeKey(env, key)
await Bun.write(envPath, env)

if (!key) {
	warn('No Solami API key: the indexer will run on the public RPC fallback (SOURCE=rpc)')
} else {
	const status = await checkKey(key)
	if (status === 'valid') ok('Solami API key works')
	else if (status === 'invalid')
		warn('Solami rejected the key (401/403). Fix it in apps/indexer/.env')
	else warn('Could not verify the key right now (network or API error). It was saved anyway')
}

step('3. Data directory')
mkdirSync(join(root, 'data'), { recursive: true })
ok('data/ ready (SQLite lives in data/radar.sqlite)')

console.log(`
${bold('All set.')} Start everything with:

  ${bold('bun dev')}          indexer on :4000 + web on http://localhost:3100/dbc-radar

${dim('Other variables (endpoints, ports, DB path) are documented in apps/indexer/.env.example')}`)
