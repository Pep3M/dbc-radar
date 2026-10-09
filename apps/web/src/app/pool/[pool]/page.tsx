import { Suspense } from 'react'
import { PoolView } from '@/components/pool-view'

const Pool = async ({ params }: { params: PageProps<'/pool/[pool]'>['params'] }) => {
	const { pool } = await params
	return <PoolView pool={pool} />
}

export default function PoolPage({ params }: PageProps<'/pool/[pool]'>) {
	return (
		<Suspense fallback={<p className="p-6 text-sm text-white/45">Loading…</p>}>
			<Pool params={params} />
		</Suspense>
	)
}
