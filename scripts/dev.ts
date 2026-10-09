// Runs the indexer and the web dashboard together with prefixed output.
// Ctrl+C (or either process dying) stops both.
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
const envPath = join(root, 'apps/indexer/.env')
const webPort = process.env.WEB_PORT ?? '3100'

if (!existsSync(join(root, 'node_modules'))) {
	console.error('Dependencies are missing. Run `bun run setup` first.')
	process.exit(1)
}

const indexerEnv = existsSync(envPath) ? await Bun.file(envPath).text() : ''
if (!indexerEnv) console.warn('\x1b[33m!\x1b[0m apps/indexer/.env not found: run `bun run setup`')
else if (!/^SOLAMI_API_KEY=\S+/m.test(indexerEnv))
	console.warn('\x1b[33m!\x1b[0m No SOLAMI_API_KEY: the indexer will use the public RPC fallback')
const indexerPort = indexerEnv.match(/^PORT=(\d+)/m)?.[1] ?? '4000'

const services = [
	{
		name: 'indexer',
		color: 36,
		cwd: 'apps/indexer',
		cmd: [process.execPath, '--watch', 'src/index.ts'],
		env: {},
	},
	{
		name: 'web',
		color: 35,
		cwd: 'apps/web',
		cmd: [process.execPath, '--bun', 'next', 'dev', '-p', webPort],
		env: { INDEXER_URL: `http://localhost:${indexerPort}` },
	},
]
const width = Math.max(...services.map((s) => s.name.length))

const pipe = async (stream: ReadableStream<Uint8Array>, prefix: string) => {
	const decoder = new TextDecoder()
	let buffer = ''
	for await (const chunk of stream) {
		buffer += decoder.decode(chunk, { stream: true })
		const lines = buffer.split('\n')
		buffer = lines.pop() ?? ''
		for (const line of lines) process.stdout.write(`${prefix}${line}\n`)
	}
	if (buffer) process.stdout.write(`${prefix}${buffer}\n`)
}

const children = services.map((s) => {
	const proc = Bun.spawn(s.cmd, {
		cwd: join(root, s.cwd),
		env: { ...process.env, FORCE_COLOR: '1', ...s.env },
		stdout: 'pipe',
		stderr: 'pipe',
	})
	const prefix = `\x1b[${s.color}m${s.name.padEnd(width)} │\x1b[0m `
	pipe(proc.stdout, prefix)
	pipe(proc.stderr, prefix)
	return { ...s, proc }
})

console.log(`\x1b[1mDBC Radar\x1b[0m → http://localhost:${webPort}/dbc-radar\n`)

let stopping = false
const stop = async (code: number) => {
	if (stopping) return
	stopping = true
	for (const { proc } of children) proc.kill()
	await Promise.all(children.map(({ proc }) => proc.exited))
	process.exit(code)
}

process.on('SIGINT', () => stop(0))
process.on('SIGTERM', () => stop(0))

const first = await Promise.race(
	children.map(async (c) => ({ name: c.name, code: await c.proc.exited })),
)
if (!stopping) {
	console.error(`\n${first.name} exited with code ${first.code}, stopping the rest`)
	await stop(first.code || 1)
}
