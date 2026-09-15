import { describe, expect, test } from 'vitest'
import { analyticsPresetPeriod, analyticsRange, currentMonthPeriod, moveAnalyticsPeriod } from '../src/client/renderer/src/analytics-period'

describe('analytics periods', () => {
  test('uses the current local calendar month at month boundaries', () => {
    expect(currentMonthPeriod(new Date(2026, 0, 31, 23, 59))).toEqual({ start: '2026-01-01', end: '2026-01-31' })
    expect(currentMonthPeriod(new Date(2026, 1, 1, 0, 1))).toEqual({ start: '2026-02-01', end: '2026-02-28' })
  })

  test('includes leap day in a leap-year month', () => {
    expect(currentMonthPeriod(new Date(2024, 1, 12))).toEqual({ start: '2024-02-01', end: '2024-02-29' })
    expect(currentMonthPeriod(new Date(2025, 1, 12))).toEqual({ start: '2025-02-01', end: '2025-02-28' })
  })

  test('builds live range presets from the supplied local date', () => {
    const now = new Date(2026, 8, 15, 12)
    expect(analyticsPresetPeriod('7d', now)).toEqual({ start: '2026-09-09', end: '2026-09-15' })
    expect(analyticsPresetPeriod('30d', now)).toEqual({ start: '2026-08-17', end: '2026-09-15' })
    expect(analyticsPresetPeriod('this-month', now)).toEqual({ start: '2026-09-01', end: '2026-09-30' })
    expect(analyticsPresetPeriod('last-month', now)).toEqual({ start: '2026-08-01', end: '2026-08-31' })
    expect(analyticsPresetPeriod('all', now)).toEqual({ start: '1970-01-01', end: '2026-09-15' })
  })

  test('moves custom ranges backward and forward by the same inclusive length', () => {
    const period = { start: '2026-03-10', end: '2026-03-12' }
    expect(moveAnalyticsPeriod(period, -1)).toEqual({ start: '2026-03-07', end: '2026-03-09' })
    expect(moveAnalyticsPeriod(period, 1)).toEqual({ start: '2026-03-13', end: '2026-03-15' })
    expect(moveAnalyticsPeriod({ start: '2024-02-28', end: '2024-02-29' }, 1)).toEqual({ start: '2024-03-01', end: '2024-03-02' })
  })

  test('converts local inclusive dates to an exclusive API boundary', () => {
    expect(analyticsRange({ start: '2026-03-08', end: '2026-03-10' })).toEqual({
      startAt: new Date(2026, 2, 8).getTime(),
      endAt: new Date(2026, 2, 11).getTime()
    })
  })

  test('rejects invalid and inverted date ranges', () => {
    expect(() => analyticsRange({ start: '2026-02-30', end: '2026-03-01' })).toThrow('Invalid calendar date')
    expect(() => analyticsRange({ start: '2026-03-02', end: '2026-03-01' })).toThrow('Start date must not be after end date')
  })
})
