import { describe, expect, test, vi } from 'vitest'
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_MAX_BACKOFF_MS,
  UPDATE_CHECK_MIN_BACKOFF_MS,
  backoffDelay,
  createUpdateChecker,
  interpretCompare,
  rateLimitRetryAt,
  type UpdateCheckerDeps
} from '../apps/web/src/update-check'

const BUILD = 'a'.repeat(40)
const LATEST = 'b'.repeat(40)

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(status === 304 ? null : JSON.stringify(body), { status, headers })
}

type FakeTimer = { fire: () => void; delay: number }

function harness(responses: Array<Response | Error>, overrides: Partial<UpdateCheckerDeps> = {}) {
  let clock = 1_000_000
  const timers: FakeTimer[] = []
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  let focusListener: (() => void) | null = null
  const fetch = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers })
    const next = responses.shift()
    if (!next) throw new Error('unexpected fetch')
    if (next instanceof Error) throw next
    return next
  })
  const remove = (timer: FakeTimer) => {
    const index = timers.indexOf(timer)
    if (index >= 0) timers.splice(index, 1)
  }
  const checker = createUpdateChecker({
    buildSha: BUILD,
    enabled: true,
    fetch,
    now: () => clock,
    setTimer: (callback, delay) => {
      const timer: FakeTimer = { delay, fire: () => { remove(timer); callback() } }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => remove(timer as FakeTimer),
    onFocus: (listener) => {
      focusListener = listener
      return () => { focusListener = null }
    },
    ...overrides
  })
  return {
    checker,
    fetch,
    calls,
    timers,
    advance: (ms: number) => { clock += ms },
    focus: () => focusListener?.()
  }
}

describe('update check helpers', () => {
  test('only reports an update when main is strictly ahead', () => {
    expect(interpretCompare({ status: 'ahead', ahead_by: 3, behind_by: 0, html_url: 'https://x' }))
      .toEqual({ available: true, aheadBy: 3, compareUrl: 'https://x' })
    expect(interpretCompare({ status: 'behind', ahead_by: 0, behind_by: 2 }).available).toBe(false)
    expect(interpretCompare({ status: 'diverged', ahead_by: 2, behind_by: 1 }).available).toBe(false)
    expect(interpretCompare({ status: 'identical', ahead_by: 0, behind_by: 0 }).available).toBe(false)
    expect(interpretCompare(null).available).toBe(false)
  })

  test('backs off exponentially within bounds', () => {
    expect(backoffDelay(1)).toBe(UPDATE_CHECK_MIN_BACKOFF_MS)
    expect(backoffDelay(2)).toBe(UPDATE_CHECK_MIN_BACKOFF_MS * 2)
    expect(backoffDelay(4)).toBe(UPDATE_CHECK_MIN_BACKOFF_MS * 8)
    expect(backoffDelay(100)).toBe(UPDATE_CHECK_MAX_BACKOFF_MS)
  })

  test('reads retry-after and rate limit reset headers', () => {
    expect(rateLimitRetryAt(new Headers({ 'retry-after': '120' }), 1000)).toBe(121_000)
    expect(rateLimitRetryAt(new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '5000' }), 1000)).toBe(5_000_000)
    expect(rateLimitRetryAt(new Headers({ 'x-ratelimit-remaining': '10' }), 1000)).toBeNull()
  })
})

describe('update checker', () => {
  test('is disabled without a known build SHA', async () => {
    const { checker, fetch } = harness([], { buildSha: 'unknown' })
    checker.start()
    await checker.check()
    expect(checker.getSnapshot().status).toBe('disabled')
    expect(fetch).not.toHaveBeenCalled()
  })

  test('is disabled when update checks are turned off', async () => {
    const { checker, fetch } = harness([], { enabled: false })
    checker.start()
    await checker.check()
    expect(checker.getSnapshot().status).toBe('disabled')
    expect(fetch).not.toHaveBeenCalled()
  })

  test('reports up to date without comparing when SHAs match', async () => {
    const { checker, calls } = harness([json({ sha: BUILD }, 200, { etag: '"e1"' })])
    await checker.check()
    expect(checker.getSnapshot().status).toBe('up-to-date')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.github.com/repos/lucaspiritogit/anvil/commits/main')
  })

  test('reports an update when the build is behind and reuses ETag and compare caches', async () => {
    const { checker, calls, timers } = harness([
      json({ sha: LATEST }, 200, { etag: '"e1"' }),
      json({ status: 'ahead', ahead_by: 4, behind_by: 0, html_url: 'https://github.com/compare' }),
      json(null, 304)
    ])
    checker.start()
    await vi.waitFor(() => expect(checker.getSnapshot().status).toBe('update-available'))
    expect(checker.getSnapshot()).toMatchObject({ latestSha: LATEST, aheadBy: 4, compareUrl: 'https://github.com/compare' })
    expect(calls[1].url).toBe(`https://api.github.com/repos/lucaspiritogit/anvil/compare/${BUILD}...${LATEST}`)
    expect(timers.map((timer) => timer.delay)).toEqual([UPDATE_CHECK_INTERVAL_MS])
    timers[0].fire()
    await vi.waitFor(() => expect(timers).toHaveLength(1))
    expect(calls).toHaveLength(3)
    expect(calls[2].headers['If-None-Match']).toBe('"e1"')
    expect(checker.getSnapshot()).toMatchObject({ status: 'update-available', aheadBy: 4 })
    checker.stop()
  })

  test('does not report an update when the local build is ahead or diverged', async () => {
    const { checker } = harness([
      json({ sha: LATEST }),
      json({ status: 'diverged', ahead_by: 2, behind_by: 1, html_url: 'https://x' })
    ])
    await checker.check()
    expect(checker.getSnapshot()).toMatchObject({ status: 'up-to-date', aheadBy: 0, compareUrl: null })
  })

  test('treats a build SHA unknown to GitHub as not behind', async () => {
    const { checker } = harness([json({ sha: LATEST }), json({ message: 'Not Found' }, 404)])
    await checker.check()
    expect(checker.getSnapshot().status).toBe('up-to-date')
  })

  test('backs off on rate limits using the reset header', async () => {
    const { checker, timers } = harness([
      json({ message: 'rate limited' }, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1600' })
    ])
    checker.start()
    await vi.waitFor(() => expect(checker.getSnapshot().status).toBe('error'))
    expect(timers.map((timer) => timer.delay)).toEqual([600_000])
    checker.stop()
  })

  test('backs off exponentially on network failures and keeps the last result', async () => {
    const { checker, timers } = harness([
      json({ sha: LATEST }),
      json({ status: 'ahead', ahead_by: 1, behind_by: 0, html_url: 'https://x' }),
      new TypeError('Failed to fetch'),
      new TypeError('Failed to fetch')
    ])
    checker.start()
    await vi.waitFor(() => expect(checker.getSnapshot().status).toBe('update-available'))
    timers[0].fire()
    await vi.waitFor(() => expect(timers[0]?.delay).toBe(UPDATE_CHECK_MIN_BACKOFF_MS))
    expect(checker.getSnapshot()).toMatchObject({ status: 'update-available', error: 'Failed to fetch' })
    timers[0].fire()
    await vi.waitFor(() => expect(timers[0]?.delay).toBe(UPDATE_CHECK_MIN_BACKOFF_MS * 2))
    checker.stop()
    expect(timers).toHaveLength(0)
  })

  test('throttles focus checks and respects backoff', async () => {
    const { checker, fetch, advance, focus } = harness([
      json({ sha: BUILD }),
      new TypeError('offline'),
      json({ sha: BUILD })
    ])
    checker.start()
    await vi.waitFor(() => expect(checker.getSnapshot().status).toBe('up-to-date'))
    focus()
    expect(fetch).toHaveBeenCalledTimes(1)
    advance(5 * 60_000)
    focus()
    await vi.waitFor(() => expect(checker.getSnapshot().error).toBe('offline'))
    expect(fetch).toHaveBeenCalledTimes(2)
    advance(30_000)
    focus()
    expect(fetch).toHaveBeenCalledTimes(2)
    advance(5 * 60_000)
    focus()
    await vi.waitFor(() => expect(checker.getSnapshot().error).toBeNull())
    expect(fetch).toHaveBeenCalledTimes(3)
    checker.stop()
  })

  test('skips the request while offline', async () => {
    const { checker, fetch, timers } = harness([], { isOnline: () => false })
    checker.start()
    await vi.waitFor(() => expect(timers).toHaveLength(1))
    expect(fetch).not.toHaveBeenCalled()
    checker.stop()
  })
})
