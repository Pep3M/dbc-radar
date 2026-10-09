import type { Metadata } from 'next'
import { AlertsView } from '@/components/alerts/alerts-view'

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? ''

export const metadata: Metadata = {
	title: 'Alerts',
	description:
		'Webhook and Telegram alerts when a Meteora DBC curve crosses a threshold, graduates or raises a strong risk flag.',
	alternates: { canonical: `${basePath}/alerts` },
}

export default function AlertsPage() {
	return <AlertsView />
}
