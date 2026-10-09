import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import './globals.css'

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] })
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? ''

export const metadata: Metadata = {
	metadataBase: new URL('https://pep3marquez.com'),
	alternates: { canonical: `${basePath}/` },
	openGraph: {
		type: 'website',
		siteName: 'pep3marquez',
		title: 'DBC Radar — live Meteora launch radar',
		description:
			'Every Meteora Dynamic Bonding Curve launch on Solana, live: curve progress, flow, holders and rug signals.',
		url: `${basePath}/`,
	},
	title: 'DBC Radar — live Meteora launch radar',
	description:
		'Real-time radar for Meteora Dynamic Bonding Curve launches on Solana: curve progress, flow, graduations and rug signals. Powered by Solami.',
}

export default function RootLayout({ children }: LayoutProps<'/'>) {
	return (
		<html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
			<body className="flex min-h-full flex-col font-sans">{children}</body>
		</html>
	)
}
