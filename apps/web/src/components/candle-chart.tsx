'use client'

import {
	CandlestickSeries,
	ColorType,
	CrosshairMode,
	createChart,
	createSeriesMarkers,
	HistogramSeries,
	type IChartApi,
	type ISeriesApi,
	type ISeriesMarkersPluginApi,
	type SeriesMarker,
	type Time,
	type UTCTimestamp,
} from 'lightweight-charts'
import { useEffect, useRef } from 'react'
import type { PoolDetail } from '@/lib/api'
import { price as fmtPrice } from '@/lib/format'
import { tokenFont, tokenRgba } from '@/lib/theme'

type Candle = PoolDetail['candles'][number]

export type ChartMarker = { ts: number; kind: 'graduated' | 'creator_sold' }

type Palette = ReturnType<typeof readColors>

// lightweight-charts can't parse oklch: resolve the tokens to rgba once per theme.
const readColors = () => ({
	ink3: tokenRgba('ink-3'),
	line: tokenRgba('line'),
	lineSoft: tokenRgba('line-soft'),
	bg3: tokenRgba('bg-3'),
	buy: tokenRgba('buy'),
	sell: tokenRgba('sell'),
	signal: tokenRgba('signal'),
	risk: tokenRgba('risk'),
	buyA: tokenRgba('buy', 0.35),
	sellA: tokenRgba('sell', 0.35),
})

const toTime = (ms: number) => Math.floor(ms / 1000) as UTCTimestamp
const minuteOf = (ms: number) => (Math.floor(ms / 60_000) * 60) as UTCTimestamp

/**
 * 1m price candles in USD (quote price × USD per quote). Up candles filled `buy`, down
 * candles hollow with a `sell` border, so direction survives colour blindness and
 * greyscale; volume histogram underneath tinted by direction; GRADUATED / CREATOR SOLD
 * markers. Updates the last bar in place when only it changed, so zoom is kept.
 */
export const CandleChart = ({
	candles,
	usdPerQuote,
	markers = [],
	className = 'h-[200px] sm:h-[340px]',
}: {
	candles: Candle[]
	/** Null when the USD rate is unknown: the chart then shows quote prices. */
	usdPerQuote: number | null
	markers?: ChartMarker[]
	className?: string
}) => {
	const containerRef = useRef<HTMLDivElement>(null)
	const chartRef = useRef<{
		chart: IChartApi
		price: ISeriesApi<'Candlestick'>
		volume: ISeriesApi<'Histogram'>
		markers: ISeriesMarkersPluginApi<Time>
		colors: Palette
		first: number | null
		length: number
	} | null>(null)

	useEffect(() => {
		if (!containerRef.current) return
		const colors = readColors()
		const chart = createChart(containerRef.current, {
			autoSize: true,
			layout: {
				background: { type: ColorType.Solid, color: 'rgba(0, 0, 0, 0)' },
				textColor: colors.ink3,
				fontFamily: tokenFont('mono'),
				fontSize: 11,
			},
			grid: {
				vertLines: { color: colors.lineSoft },
				horzLines: { color: colors.lineSoft },
			},
			rightPriceScale: { borderColor: colors.line },
			timeScale: {
				borderColor: colors.line,
				timeVisible: true,
				secondsVisible: false,
				rightOffset: 4,
			},
			crosshair: {
				mode: CrosshairMode.Normal,
				vertLine: { color: colors.ink3, labelBackgroundColor: colors.bg3 },
				horzLine: { color: colors.ink3, labelBackgroundColor: colors.bg3 },
			},
			localization: { priceFormatter: (p: number) => fmtPrice(p) },
		})
		const price = chart.addSeries(CandlestickSeries, {
			upColor: colors.buy,
			downColor: 'rgba(0, 0, 0, 0)',
			borderUpColor: colors.buy,
			borderDownColor: colors.sell,
			wickUpColor: colors.buy,
			wickDownColor: colors.sell,
			priceLineColor: colors.ink3,
			priceFormat: { type: 'custom', formatter: (p: number) => fmtPrice(p), minMove: 1e-12 },
		})
		price.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.22 } })
		const volume = chart.addSeries(HistogramSeries, {
			priceScaleId: 'vol',
			priceFormat: { type: 'volume' },
			lastValueVisible: false,
			priceLineVisible: false,
		})
		chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
		chartRef.current = {
			chart,
			price,
			volume,
			markers: createSeriesMarkers(price, []),
			colors,
			first: null,
			length: 0,
		}
		return () => {
			chart.remove()
			chartRef.current = null
		}
	}, [])

	useEffect(() => {
		const c = chartRef.current
		if (!c) return
		const k = usdPerQuote ?? 1
		const bars = candles.map((d) => ({
			time: toTime(d.bucket),
			open: d.open * k,
			high: d.high * k,
			low: d.low * k,
			close: d.close * k,
		}))
		const vols = candles.map((d) => ({
			time: toTime(d.bucket),
			value: d.volume ?? 0,
			color: d.close >= d.open ? c.colors.buyA : c.colors.sellA,
		}))
		const first = candles[0]?.bucket ?? null
		const incremental =
			c.first === first && c.length > 0 && bars.length - c.length <= 1 && bars.length >= c.length
		if (incremental && bars.length > 0) {
			c.price.update(bars[bars.length - 1])
			c.volume.update(vols[vols.length - 1])
		} else {
			c.price.setData(bars)
			c.volume.setData(vols)
			c.chart.timeScale().fitContent()
		}
		c.first = first
		c.length = bars.length
	}, [candles, usdPerQuote])

	const markerKey = markers.map((m) => `${m.kind}:${minuteOf(m.ts)}`).join('|')
	useEffect(() => {
		const c = chartRef.current
		if (!c) return
		const times = new Set(candles.map((d) => toTime(d.bucket)))
		const list: SeriesMarker<Time>[] = [
			...new Map(markerKey ? markerKey.split('|').map((k) => [k, k]) : []).keys(),
		]
			.map((k) => {
				const [kind, t] = k.split(':')
				return { kind, time: Number(t) as UTCTimestamp }
			})
			.filter((m) => times.has(m.time))
			.sort((a, b) => a.time - b.time)
			.map(({ kind, time }) =>
				kind === 'graduated'
					? {
							time,
							position: 'aboveBar' as const,
							color: c.colors.signal,
							shape: 'circle' as const,
							text: 'GRADUATED',
						}
					: {
							time,
							position: 'aboveBar' as const,
							color: c.colors.risk,
							shape: 'arrowDown' as const,
							text: 'CREATOR SOLD',
						},
			)
		c.markers.setMarkers(list)
	}, [markerKey, candles])

	return <div ref={containerRef} className={`relative w-full ${className}`} />
}
