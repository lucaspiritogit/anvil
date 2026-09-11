import { expect, test } from 'vitest'
import { formatDuration } from '../src/renderer/src/format'

test('paused totals ignore review time and historical task timestamps', () => {
  const task = { workingTimeMs: 65000, startedAt: 0, endedAt: 900000 }
  expect(formatDuration(task, 1000000)).toBe('1m 5s')
  expect(formatDuration(task, 2000000)).toBe('1m 5s')
})

test('active intervals add only work since the latest resume or checkpoint', () => {
  expect(formatDuration({ workingTimeMs: 65000, workingStartedAt: 1000000 }, 1005000)).toBe('1m 10s')
  expect(formatDuration({ workingStartedAt: 0 }, 5000)).toBe('5s')
})

test('missing legacy measurements never infer work from task lifetime', () => {
  const task = { workingTimeMs: undefined, startedAt: 0, endedAt: 900000 }
  expect(formatDuration(task, 1000000)).toBe('0s')
  expect(formatDuration({}, 1000000)).toBe('0s')
})

test('negative totals and future intervals cannot produce negative durations', () => {
  expect(formatDuration({ workingTimeMs: -5000 }, 10000)).toBe('0s')
  expect(formatDuration({ workingTimeMs: 5000, workingStartedAt: 20000 }, 10000)).toBe('5s')
  expect(formatDuration({ workingTimeMs: -5000, workingStartedAt: 20000 }, 10000)).toBe('0s')
})

test.each([
  [0, '0s'], [999, '0s'], [1000, '1s'], [59999, '59s'],
  [60000, '1m 0s'], [61000, '1m 1s'], [3599999, '59m 59s'],
  [3600000, '1h 0m'], [3660000, '1h 1m'], [90000000, '25h 0m']
])('formats %i milliseconds as %s', (workingTimeMs, expected) => {
  expect(formatDuration({ workingTimeMs }, 0)).toBe(expected)
})
