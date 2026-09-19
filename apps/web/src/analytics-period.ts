import type { AnalyticsRange } from '@anvil/protocol/types'

export interface AnalyticsPeriod {
  start: string
  end: string
}

export type AnalyticsPreset = '7d' | '30d' | 'this-month' | 'last-month' | 'all'

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function dateParts(value: string): [number, number, number] {
  const match = DATE_PATTERN.exec(value)
  if (!match) throw new Error('Invalid calendar date')
  const parts: [number, number, number] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(parts[0], parts[1] - 1, parts[2], 12)
  if (date.getFullYear() !== parts[0] || date.getMonth() !== parts[1] - 1 || date.getDate() !== parts[2]) {
    throw new Error('Invalid calendar date')
  }
  return parts
}

function formatDate(date: Date): string {
  const year = String(date.getFullYear()).padStart(4, '0')
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addDays(value: string, days: number): string {
  const [year, month, day] = dateParts(value)
  return formatDate(new Date(year, month - 1, day + days, 12))
}

function inclusiveDays(period: AnalyticsPeriod): number {
  const [startYear, startMonth, startDay] = dateParts(period.start)
  const [endYear, endMonth, endDay] = dateParts(period.end)
  return Math.round((Date.UTC(endYear, endMonth - 1, endDay) - Date.UTC(startYear, startMonth - 1, startDay)) / 86_400_000) + 1
}

export function currentMonthPeriod(now = new Date()): AnalyticsPeriod {
  return {
    start: formatDate(new Date(now.getFullYear(), now.getMonth(), 1, 12)),
    end: formatDate(new Date(now.getFullYear(), now.getMonth() + 1, 0, 12))
  }
}

export function analyticsPresetPeriod(preset: AnalyticsPreset, now = new Date()): AnalyticsPeriod {
  const today = formatDate(now)
  if (preset === '7d') return { start: addDays(today, -6), end: today }
  if (preset === '30d') return { start: addDays(today, -29), end: today }
  if (preset === 'this-month') return currentMonthPeriod(now)
  if (preset === 'last-month') {
    return {
      start: formatDate(new Date(now.getFullYear(), now.getMonth() - 1, 1, 12)),
      end: formatDate(new Date(now.getFullYear(), now.getMonth(), 0, 12))
    }
  }
  return { start: '1970-01-01', end: today }
}

export function moveAnalyticsPeriod(period: AnalyticsPeriod, direction: -1 | 1): AnalyticsPeriod {
  const days = inclusiveDays(period)
  if (days < 1) throw new Error('Start date must not be after end date')
  if (direction < 0) {
    const end = addDays(period.start, -1)
    return { start: addDays(end, 1 - days), end }
  }
  const start = addDays(period.end, 1)
  return { start, end: addDays(start, days - 1) }
}

export function analyticsRange(period: AnalyticsPeriod): AnalyticsRange {
  const [startYear, startMonth, startDay] = dateParts(period.start)
  const [endYear, endMonth, endDay] = dateParts(period.end)
  if (inclusiveDays(period) < 1) throw new Error('Start date must not be after end date')
  return {
    startAt: new Date(startYear, startMonth - 1, startDay).getTime(),
    endAt: new Date(endYear, endMonth - 1, endDay + 1).getTime()
  }
}
