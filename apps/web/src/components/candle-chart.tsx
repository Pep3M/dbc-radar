'use client'

import {
	CandlestickSeries,
	ColorType,
	createChart,
	HistogramSeries,
	type IChartApi,
	type ISeriesApi,
	type UTCTimestamp,
} from 'lightweight-charts'
import { useEffect, useRef } from 'react'
import type { PoolDetail } from '@/lib/api'

type Candle = PoolDetail['candles'][number]

export const CandleChart = ({
	candles,
	usdPerQuote,
}: {
	candles: Candle[]
	usdPerQuote: number
}) => {
	const containerRef = useRef<HTMLDivElement>(null)
	const chartRef = useRef<{
		chart: IChartApi
		price: ISeriesApi<'Candlestick'>
		volume: ISeriesApi<'Histogram'>
	} | null>(null)

	useEffect(() => {
		if (!containerRef.current) return
		const chart = createChart(containerRef.current, {
			autoSize: true,
			layout: {
				background: { type: ColorType.Solid, color: 'transparent' },
				textColor: 'rgba(255,255,255,0.55)',
				fontFamily: 'var(--font-geist-mono)',
			},
			grid: {
				vertLines: { color: 'rgba(255,255,255,0.04)' },
				horzLines: { color: 'rgba(255,255,255,0.04)' },
			},
			timeScale: { timeVisible: true, secondsVisible: false },
			rightPriceScale: { borderColor: 'rgba(255,255,255,0.1)' },
		})
		const price = chart.addSeries(CandlestickSeries, {
			upColor: '#34d399',
			downColor: '#f87171',
			borderVisible: false,
			wickUpColor: '#34d399',
			wickDownColor: '#f87171',
			priceFormat: { type: 'price', precision: 10, minMove: 1e-10 },
		})
		const volume = chart.addSeries(HistogramSeries, {
			priceScaleId: 'volume',
			priceFormat: { type: 'volume' },
			color: 'rgba(56,189,248,0.35)',
		})
		chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })
		chartRef.current = { chart, price, volume }
		return () => {
			chart.remove()
			chartRef.current = null
		}
	}, [])

	useEffect(() => {
		const current = chartRef.current
		if (!current) return
		current.price.setData(
			candles.map((c) => ({
				time: (c.bucket / 1000) as UTCTimestamp,
				open: c.open * usdPerQuote,
				high: c.high * usdPerQuote,
				low: c.low * usdPerQuote,
				close: c.close * usdPerQuote,
			})),
		)
		current.volume.setData(
			candles.map((c) => ({ time: (c.bucket / 1000) as UTCTimestamp, value: c.volume ?? 0 })),
		)
	}, [candles, usdPerQuote])

	return <div ref={containerRef} className="h-[360px] w-full" />
}
