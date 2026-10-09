import type { NextConfig } from 'next'

const basePath = process.env.BASE_PATH ?? '/dbc-radar'
const indexerUrl = process.env.INDEXER_URL ?? 'http://localhost:4000'

const nextConfig: NextConfig = {
	basePath,
	output: 'standalone',
	cacheComponents: true,
	partialPrefetching: true,
	env: { NEXT_PUBLIC_BASE_PATH: basePath },
	// In production a reverse proxy routes `${basePath}/api` straight to the indexer;
	// this rewrite only matters for `next dev` / `next start` without one.
	// The origin hostname is noindex; the edge Worker strips this header on pep3marquez.com.
	async headers() {
		return [{ source: '/:path*', headers: [{ key: 'X-Robots-Tag', value: 'noindex' }] }]
	},
	async rewrites() {
		return [{ source: '/api/:path*', destination: `${indexerUrl}/api/:path*` }]
	},
	turbopack: {
		rules: {
			'*.css': {
				loaders: ['@tailwindcss/turbopack'],
				as: '*.css',
			},
		},
	},
}

export default nextConfig
