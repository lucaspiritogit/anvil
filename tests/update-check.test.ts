import { describe, expect, test, vi } from 'vitest'
import type { ServerUpdateState } from '@anvil/protocol/server-updates'
import { compareVersions } from '@anvil/protocol/server-updates'
import {
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_CHECK_MAX_BACKOFF_MS,
  UPDATE_CHECK_MIN_BACKOFF_MS,
  backoffDelay,
  createUpdateChecker,
  updateKey,
  type UpdateCheckerDeps
} from '../apps/web/src/update-check'

function server(patch: Partial<ServerUpdateState> = {}): ServerUpdateState {
  return {
    currentVersion: '2.4.0', latestVersion: '2.4.0', available: false, installable: true,
    phase: 'idle', progress: null, error: null, checkedAt: 1, ...patch
  }
}

type FakeTimer = { fire: () => void; delay: number }

function harness(responses: Array<ServerUpdateState | Error>, overrides: Partial<UpdateCheckerDeps> = {}) {
  let clock = 1_000_000
  const timers: FakeTimer[] = []
  let focusListener: (() => void) | null = null
  let push: ((state: ServerUpdateState) => void) | null = null
  const check = vi.fn(async (_force: boolean) => {
    const next = responses.shift()
    if (!next) throw new Error('unexpected check')
    if (next instanceof Error) throw next
    return next
  })
  const remove = (timer: FakeTimer) => {
    const index = timers.indexOf(timer)
    if (index >= 0) timers.splice(index, 1)
  }
  const checker = createUpdateChecker({
    enabled: true,
    check,
    onChanged: (listener) => {
      push = listener
      return () => { push = null }
    },
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
    check,
    timers,
    advance: (ms: number) => { clock += ms },
    focus: () => focusListener?.(),
    push: (state: ServerUpdateState) => push?.(state)
  }
}

describe('update check helpers', () => {
  test('backs off exponentially within bounds', () => {
    expect(backoffDelay(1)).toBe(UPDATE_CHECK_MIN_BACKOFF_MS)
    expect(backoffDelay(2)).toBe(UPDATE_CHECK_MIN_BACKOFF_MS * 2)
    expect(backoffDelay(3)).toBe(UPDATE_CHECK_MIN_BACKOFF_MS * 4)
    expect(backoffDelay(100)).toBe(UPDATE_CHECK_MAX_BACKOFF_MS)
  })

  test('compares semantic versions including prereleases', () => {
    expect(compareVersions('1.1.0', '1.0.9')).toBe(1)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0', '1.0.0-beta.2')).toBe(1)
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBe(-1)
  })

  test('only keys an update the server reports as available', () => {
    expect(updateKey({ server: null })).toBeNull()
    expect(updateKey({ server: server() })).toBeNull()
    expect(updateKey({ server: server({ latestVersion: '2.5.0', available: true }) })).toBe('v2.5.0')
  })
})

describe('update checker', () => {
  test('is disabled when update checks are turned off', async () => {
    const { checker, check } = harness([], { enabled: false })
    checker.start()
    await checker.check()
    expect(checker.getSnapshot().status).toBe('disabled')
    expect(check).not.toHaveBeenCalled()
  })

  test('reports up to date when the installed version is the latest release', async () => {
    const { checker, timers } = harness([server()])
    checker.start()
    await checker.check()
    expect(checker.getSnapshot()).toMatchObject({ status: 'up-to-date', error: null })
    expect(updateKey(checker.getSnapshot())).toBeNull()
    expect(timers.map((timer) => timer.delay)).toEqual([UPDATE_CHECK_INTERVAL_MS])
  })

  test('reports a newer release and forces a fresh check on request', async () => {
    const { checker, check } = harness([server(), server({ latestVersion: '2.5.0', available: true })])
    checker.start()
    await checker.check()
    await checker.check(true)
    expect(check.mock.calls.map(([force]) => force)).toEqual([false, true])
    expect(checker.getSnapshot().status).toBe('update-available')
    expect(updateKey(checker.getSnapshot())).toBe('v2.5.0')
  })

  test('follows install progress pushed by the server', async () => {
    const { checker, push } = harness([server({ latestVersion: '2.5.0', available: true })])
    checker.start()
    await checker.check()
    push(server({ latestVersion: '2.5.0', available: true, phase: 'downloading', progress: 40 }))
    expect(checker.getSnapshot().server).toMatchObject({ phase: 'downloading', progress: 40 })
    expect(checker.getSnapshot().status).toBe('update-available')
    checker.stop()
    push(server({ phase: 'restarting' }))
    expect(checker.getSnapshot().server?.phase).toBe('downloading')
  })

  test('backs off exponentially on failures and keeps the last result', async () => {
    const { checker, timers } = harness([
      server({ latestVersion: '2.5.0', available: true }),
      new Error('offline'),
      new Error('offline')
    ])
    checker.start()
    await checker.check()
    await checker.check()
    expect(checker.getSnapshot()).toMatchObject({ status: 'update-available', error: 'offline' })
    expect(timers.at(-1)?.delay).toBe(UPDATE_CHECK_MIN_BACKOFF_MS)
    await checker.check()
    expect(timers.at(-1)?.delay).toBe(UPDATE_CHECK_MIN_BACKOFF_MS * 2)
  })

  test('reports an error when the first check fails', async () => {
    const { checker } = harness([new Error('Update feed responded with 500')])
    checker.start()
    await checker.check()
    expect(checker.getSnapshot()).toMatchObject({ status: 'error', error: 'Update feed responded with 500', server: null })
  })

  test('throttles focus checks and respects backoff', async () => {
    const { checker, check, advance, focus } = harness([server(), new Error('offline'), server()])
    checker.start()
    await checker.check()
    focus()
    expect(check).toHaveBeenCalledTimes(1)
    advance(6 * 60_000)
    focus()
    await checker.check()
    expect(check).toHaveBeenCalledTimes(2)
    advance(30_000)
    focus()
    expect(check).toHaveBeenCalledTimes(2)
    advance(6 * 60_000)
    focus()
    await checker.check()
    expect(check).toHaveBeenCalledTimes(3)
  })

  test('skips the request while offline', async () => {
    const { checker, check, timers } = harness([], { isOnline: () => false })
    checker.start()
    await checker.check()
    expect(check).not.toHaveBeenCalled()
    expect(timers.map((timer) => timer.delay)).toEqual([UPDATE_CHECK_INTERVAL_MS])
  })
})
