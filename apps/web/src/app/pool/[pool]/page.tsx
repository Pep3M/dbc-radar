import { Suspense } from 'react'
import { PoolSkeleton, PoolView } from '@/components/pool-view'

const Pool = async ({ params }: { params: PageProps<'/pool/[pool]'>['params'] }) => {
	const { pool } = await params
	return <PoolView pool={pool} />
}

export default function PoolPage({ params }: PageProps<'/pool/[pool]'>) {
	return (
		<Suspense fallback={<PoolSkeleton />}>
			<Pool params={params} />
		</Suspense>
	)
}
