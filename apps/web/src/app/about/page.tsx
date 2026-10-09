import type { Metadata } from 'next'
import { HoodView } from '@/components/hood/hood-view'

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? ''

export const metadata: Metadata = {
	title: 'Under the hood',
	description:
		'Public RPC polling versus Solami Yellowstone gRPC streaming, raced live in your browser, plus the live data path and per-signature gRPC vs Blur latency.',
	alternates: { canonical: `${basePath}/about` },
}

export default function AboutPage() {
	return <HoodView />
}
