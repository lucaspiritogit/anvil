export const UPDATE_CHECK_REPOSITORY = 'lucaspiritogit/anvil'
export const UPDATE_CHECK_BRANCH = 'main'
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000
export const UPDATE_CHECK_FOCUS_THROTTLE_MS = 5 * 60_000
export const UPDATE_CHECK_MIN_BACKOFF_MS = 60_000
export const UPDATE_CHECK_MAX_BACKOFF_MS = 6 * 60 * 60_000

export type UpdateCheckStatus = 'disabled' | 'idle' | 'checking' | 'up-to-date' | 'update-available' | 'error'

export type UpdateCheckState = {
  status: UpdateCheckStatus
  buildSha: string | null
  latestSha: string | null
  aheadBy: number
  compareUrl: string | null
  lastCheckedAt: number | null
  nextCheckAt: number | null
  error: string | null
}

type Timer = unknown

export type UpdateCheckerDeps = {
  buildSha: string | null
  enabled: boolean
  fetch: (url: string, init: { headers: Record<string, string> }) => Promise<Response>
  now?: () => number
  setTimer?: (callback: () => void, delay: number) => Timer
  clearTimer?: (timer: Timer) => void
  isOnline?: () => boolean
  onFocus?: (listener: () => void) => () => void
  onOnline?: (listener: () => void) => () => void
  repository?: string
  branch?: string
  intervalMs?: number
  focusThrottleMs?: number
}

export type UpdateChecker = {
  getSnapshot: () => UpdateCheckState
  subscribe: (listener: () => void) => () => void
  check: () => Promise<void>
  start: () => void
  stop: () => void
}

type CompareResult = { available: boolean; aheadBy: number; compareUrl: string | null }

class RateLimitError extends Error {
  constructor(readonly retryAt: number | null) {
    super('GitHub rate limit reached')
  }
}

const SHA_PATTERN = /^[0-9a-f]{40}$/i

export function backoffDelay(failures: number, min = UPDATE_CHECK_MIN_BACKOFF_MS, max = UPDATE_CHECK_MAX_BACKOFF_MS): number {
  const exponent = Math.max(0, failures - 1)
  return Math.min(max, min * 2 ** Math.min(exponent, 30))
}

export function rateLimitRetryAt(headers: Headers, now: number): number | null {
  const retryAfter = Number(headers.get('retry-after'))
  if (Number.isFinite(retryAfter) && retryAfter > 0) return now + retryAfter * 1000
  if (headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(headers.get('x-ratelimit-reset'))
    if (Number.isFinite(reset) && reset > 0) return Math.max(now, reset * 1000)
  }
  return null
}

export function interpretCompare(body: unknown): CompareResult {
  const data = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const aheadBy = typeof data.ahead_by === 'number' && data.ahead_by > 0 ? data.ahead_by : 0
  const behindBy = typeof data.behind_by === 'number' ? data.behind_by : 0
  const compareUrl = typeof data.html_url === 'string' ? data.html_url : null
  const available = data.status === 'ahead' && aheadBy > 0 && behindBy === 0
  return { available, aheadBy: available ? aheadBy : 0, compareUrl: available ? compareUrl : null }
}

export function createUpdateChecker(deps: UpdateCheckerDeps): UpdateChecker {
  const now = deps.now ?? Date.now
  const setTimer = deps.setTimer ?? ((callback, delay) => setTimeout(callback, delay))
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const isOnline = deps.isOnline ?? (() => true)
  const repository = deps.repository ?? UPDATE_CHECK_REPOSITORY
  const branch = deps.branch ?? UPDATE_CHECK_BRANCH
  const intervalMs = deps.intervalMs ?? UPDATE_CHECK_INTERVAL_MS
  const focusThrottleMs = deps.focusThrottleMs ?? UPDATE_CHECK_FOCUS_THROTTLE_MS
  const buildSha = deps.buildSha && SHA_PATTERN.test(deps.buildSha) ? deps.buildSha.toLowerCase() : null
  const enabled = deps.enabled && buildSha !== null
  const apiBase = `https://api.github.com/repos/${repository}`
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }

  let state: UpdateCheckState = {
    status: enabled ? 'idle' : 'disabled',
    buildSha,
    latestSha: null,
    aheadBy: 0,
    compareUrl: null,
    lastCheckedAt: null,
    nextCheckAt: null,
    error: null
  }
  const listeners = new Set<() => void>()
  let etag: string | null = null
  let cachedSha: string | null = null
  let compareCache: { sha: string; result: CompareResult } | null = null
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

  async function fetchLatestSha(): Promise<string> {
    const requestHeaders: Record<string, string> = { ...headers }
    if (etag && cachedSha) requestHeaders['If-None-Match'] = etag
    const response = await deps.fetch(`${apiBase}/commits/${encodeURIComponent(branch)}`, { headers: requestHeaders })
    if (response.status === 304 && cachedSha) return cachedSha
    assertOk(response)
    const body = await response.json() as { sha?: unknown }
    if (typeof body.sha !== 'string' || !SHA_PATTERN.test(body.sha)) throw new Error('Unexpected GitHub commit response')
    etag = response.headers.get('etag')
    cachedSha = body.sha.toLowerCase()
    return cachedSha
  }

  async function compare(latestSha: string): Promise<CompareResult> {
    if (compareCache?.sha === latestSha) return compareCache.result
    const response = await deps.fetch(`${apiBase}/compare/${buildSha}...${latestSha}`, { headers: { ...headers } })
    let result: CompareResult
    if (response.status === 404) {
      result = { available: false, aheadBy: 0, compareUrl: null }
    } else {
      assertOk(response)
      result = interpretCompare(await response.json())
    }
    compareCache = { sha: latestSha, result }
    return result
  }

  function assertOk(response: Response) {
    if (response.status === 403 || response.status === 429) throw new RateLimitError(rateLimitRetryAt(response.headers, now()))
    if (!response.ok) throw new Error(`GitHub responded with ${response.status}`)
  }

  async function run() {
    if (!isOnline()) {
      schedule(intervalMs)
      return
    }
    const previous = state.status
    update({ status: 'checking', error: null })
    try {
      const latestSha = await fetchLatestSha()
      const result = latestSha === buildSha
        ? { available: false, aheadBy: 0, compareUrl: null }
        : await compare(latestSha)
      failures = 0
      blockedUntil = 0
      update({
        status: result.available ? 'update-available' : 'up-to-date',
        latestSha,
        aheadBy: result.aheadBy,
        compareUrl: result.compareUrl,
        lastCheckedAt: now(),
        error: null
      })
      schedule(intervalMs)
    } catch (error) {
      failures += 1
      const fallback = backoffDelay(failures)
      const retryAt = error instanceof RateLimitError && error.retryAt !== null ? error.retryAt : now() + fallback
      const delay = Math.min(UPDATE_CHECK_MAX_BACKOFF_MS, Math.max(UPDATE_CHECK_MIN_BACKOFF_MS, retryAt - now()))
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

  function check(): Promise<void> {
    if (!enabled) return Promise.resolve()
    if (inFlight) return inFlight
    inFlight = run().finally(() => { inFlight = null })
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
