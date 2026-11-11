import type { ServerUpdateState } from '@anvil/protocol/server-updates'

export const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000
export const UPDATE_CHECK_FOCUS_THROTTLE_MS = 5 * 60_000
export const UPDATE_CHECK_MIN_BACKOFF_MS = 60_000
export const UPDATE_CHECK_MAX_BACKOFF_MS = 6 * 60 * 60_000

export type UpdateCheckStatus = 'disabled' | 'idle' | 'checking' | 'up-to-date' | 'update-available' | 'error'

export type UpdateCheckState = {
  status: UpdateCheckStatus
  server: ServerUpdateState | null
  lastCheckedAt: number | null
  nextCheckAt: number | null
  error: string | null
}

type Timer = unknown

export type UpdateCheckerDeps = {
  enabled: boolean
  check: (force: boolean) => Promise<ServerUpdateState>
  onChanged?: (listener: (state: ServerUpdateState) => void) => () => void
  now?: () => number
  setTimer?: (callback: () => void, delay: number) => Timer
  clearTimer?: (timer: Timer) => void
  isOnline?: () => boolean
  onFocus?: (listener: () => void) => () => void
  onOnline?: (listener: () => void) => () => void
  intervalMs?: number
  focusThrottleMs?: number
}

export type UpdateChecker = {
  getSnapshot: () => UpdateCheckState
  subscribe: (listener: () => void) => () => void
  check: (force?: boolean) => Promise<void>
  start: () => void
  stop: () => void
}

export function updateKey(state: Pick<UpdateCheckState, 'server'>): string | null {
  const version = state.server?.available ? state.server.latestVersion : null
  return version ? `v${version}`.toLowerCase() : null
}

export function backoffDelay(failures: number, min = UPDATE_CHECK_MIN_BACKOFF_MS, max = UPDATE_CHECK_MAX_BACKOFF_MS): number {
  const exponent = Math.max(0, failures - 1)
  return Math.min(max, min * 2 ** Math.min(exponent, 30))
}

export function createUpdateChecker(deps: UpdateCheckerDeps): UpdateChecker {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const isOnline = deps.isOnline ?? (() => true)
  const intervalMs = deps.intervalMs ?? UPDATE_CHECK_INTERVAL_MS
  const focusThrottleMs = deps.focusThrottleMs ?? UPDATE_CHECK_FOCUS_THROTTLE_MS
  const enabled = deps.enabled

  let state: UpdateCheckState = {
    status: enabled ? 'idle' : 'disabled',
    server: null,
    lastCheckedAt: null,
    nextCheckAt: null,
    error: null
  }
  const listeners = new Set<() => void>()
  let failures = 0
  let blockedUntil = 0
  let timer: Timer | null = null
  let running = false
  let inFlight: Promise<void> | null = null
  let cleanups: Array<() => void> = []

  function update(patch: Partial<UpdateCheckState>) {
    state = { ...state, ...patch }
    for (const listener of listeners) listener()
  }

  function schedule(delay: number) {
    if (timer !== null) clearTimer(timer)
    timer = null
    if (!running) return
    const at = now() + delay
    timer = setTimer(() => {
      timer = null
      void check()
    }, delay)
    update({ nextCheckAt: at })
  }

  function receive(server: ServerUpdateState) {
    const known = state.status !== 'checking' && server.checkedAt !== null
    update({ server, ...(known ? { status: server.available ? 'update-available' as const : 'up-to-date' as const } : {}) })
  }

  async function run(force: boolean) {
    if (!isOnline()) {
      schedule(intervalMs)
      return
    }
    const previous = state.status
    update({ status: 'checking', error: null })
    try {
      const server = await deps.check(force)
      failures = 0
      blockedUntil = 0
      update({
        status: server.available ? 'update-available' : 'up-to-date',
        server,
        lastCheckedAt: now(),
        error: null
      })
      schedule(intervalMs)
    } catch (error) {
      failures += 1
      const delay = backoffDelay(failures)
      blockedUntil = now() + delay
      const keep = previous === 'update-available' || previous === 'up-to-date'
      update({
        status: keep ? previous : 'error',
        lastCheckedAt: now(),
        error: error instanceof Error ? error.message : String(error)
      })
      schedule(delay)
    }
  }

  function check(force = false): Promise<void> {
    if (!enabled) return Promise.resolve()
    if (inFlight) return inFlight
    inFlight = run(force).finally(() => { inFlight = null })
    return inFlight
  }

  function checkIfDue() {
    if (!running || inFlight) return
    const current = now()
    if (current < blockedUntil) return
    if (state.lastCheckedAt !== null && current - state.lastCheckedAt < focusThrottleMs) return
    void check()
  }

  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    check,
    start() {
      if (!enabled || running) return
      running = true
      if (deps.onChanged) cleanups.push(deps.onChanged(receive))
      if (deps.onFocus) cleanups.push(deps.onFocus(checkIfDue))
      if (deps.onOnline) cleanups.push(deps.onOnline(checkIfDue))
      void check()
    },
    stop() {
      running = false
      if (timer !== null) clearTimer(timer)
      timer = null
      for (const cleanup of cleanups) cleanup()
      cleanups = []
      update({ nextCheckAt: null })
    }
  }
}
