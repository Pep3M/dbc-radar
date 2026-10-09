import { FLAG_LABEL } from '@/components/ui'
import type { AlertFired } from '@/lib/api'

/** Glyph, tag and colours of a fired alert (Alerts rows, toasts, previews). */
export type AlertLook = {
	glyph: string
	glyphClass: string
	tag: string
	tagClass: string
	/** CSS colour for the enter tint. */
	tint: string
	telegramLabel: string
}

export const look = (alert: AlertFired, threshold: number | undefined): AlertLook => {
	if (alert.type === 'curve')
		return {
			glyph: '◎',
			glyphClass: 'text-ink',
			tag: threshold != null ? `CURVE ${Math.round(threshold * 100)}%` : 'CURVE',
			tagClass: 'bg-ink text-bg',
			tint: 'var(--color-ink)',
			telegramLabel: 'curve',
		}
	if (alert.type === 'graduated')
		return {
			glyph: '◉',
			glyphClass: 'text-signal',
			tag: 'GRADUATED',
			tagClass: 'bg-signal text-signal-ink',
			tint: 'var(--color-signal)',
			telegramLabel: 'graduated',
		}
	const flag = alert.payload.flag
	return {
		glyph: '◆',
		glyphClass: 'text-risk',
		tag: flag ? FLAG_LABEL[flag].toUpperCase() : 'RISK',
		tagClass: 'bg-risk text-risk-ink',
		tint: 'var(--color-risk)',
		telegramLabel: 'risk flag',
	}
}
