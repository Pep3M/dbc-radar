import { PoolView } from '@/components/pool-view'

export default async function PoolPage({ params }: PageProps<'/pool/[pool]'>) {
	const { pool } = await params
	return <PoolView pool={pool} />
}
