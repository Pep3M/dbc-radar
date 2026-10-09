import type { Metadata, Viewport } from 'next'
import { Big_Shoulders, Spline_Sans, Spline_Sans_Mono } from 'next/font/google'
import { HeaderStreamStatus, Shell } from '@/components/shell'
import { StreamProvider } from '@/components/stream-provider'
import './globals.css'

// "Big Shoulders Display" now ships as the variable "Big Shoulders" family with an `opsz`
// axis; globals.css pins opsz 72 (the display cut) on `font-display`.
const display = Big_Shoulders({
	variable: '--font-big-shoulders',
	subsets: ['latin', 'latin-ext'],
	weight: 'variable',
	axes: ['opsz'],
})
const sans = Spline_Sans({
	variable: '--font-spline-sans',
	subsets: ['latin', 'latin-ext'],
	weight: ['400', '500', '600'],
})
const mono = Spline_Sans_Mono({
	variable: '--font-spline-sans-mono',
	subsets: ['latin', 'latin-ext'],
	weight: ['400', '500', '600'],
})

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? ''
const title = 'DBC Radar — live Meteora launch radar'
const description =
	'Every Meteora Dynamic Bonding Curve launch on Solana, live: curve progress, flow, graduations and rug signals. Powered by Solami.'
const ogImage = {
	url: `${basePath}/og-image.png`,
	width: 1200,
	height: 630,
	alt: 'DBC Radar — every Meteora DBC launch, sensed live',
}

export const metadata: Metadata = {
	metadataBase: new URL('https://pep3marquez.com'),
	alternates: { canonical: `${basePath}/` },
	title: { default: title, template: '%s · DBC Radar' },
	description,
	openGraph: {
		type: 'website',
		siteName: 'pep3marquez',
		title,
		description,
		url: `${basePath}/`,
		images: [ogImage],
	},
	twitter: { card: 'summary_large_image', title, description, images: [ogImage.url] },
}

export const viewport: Viewport = {
	themeColor: '#16130f',
	colorScheme: 'dark',
}

export default function RootLayout({ children }: LayoutProps<'/'>) {
	return (
		<html
			lang="en"
			className={`${display.variable} ${sans.variable} ${mono.variable} h-full antialiased`}
		>
			<body className="flex min-h-full flex-col font-sans">
				<StreamProvider>
					<Shell status={<HeaderStreamStatus />}>{children}</Shell>
				</StreamProvider>
			</body>
		</html>
	)
}
