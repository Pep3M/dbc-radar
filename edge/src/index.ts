/**
 * Mounts DBC Radar at pep3marquez.com/dbc-radar without touching the main site's deploy:
 * this Worker owns the route and proxies to the Dokploy origin. Responses (including the
 * SSE stream) are passed through as streams, never buffered.
 */
type Env = { ORIGIN: string }

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)
		const target = new URL(url.pathname + url.search, env.ORIGIN)

		const headers = new Headers(request.headers)
		headers.set('x-forwarded-host', url.host)
		headers.set('x-forwarded-proto', url.protocol.replace(':', ''))

		const response = await fetch(target, {
			method: request.method,
			headers,
			body: request.body,
			redirect: 'manual',
		})

		// The origin hostname is noindex so search engines only see the pep3marquez.com URL.
		const proxied = new Response(response.body, response)
		proxied.headers.delete('x-robots-tag')
		return proxied
	},
} satisfies ExportedHandler<Env>
