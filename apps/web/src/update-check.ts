export const UPDATE_CHECK_REPOSITORY = 'lucaspiritogit/anvil'
export const UPDATE_CHECK_BRANCH = 'main'
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60_000
export const UPDATE_CHECK_FOCUS_THROTTLE_MS = 5 * 60_000
export const UPDATE_CHECK_MIN_BACKOFF_MS = 60_000
export const UPDATE_CHECK_MAX_BACKOFF_MS = 6 * 60 * 60_000

export type UpdateCheckSource = 'commits' | 'releases'

export type UpdateCheckStatus = 'disabled' | 'idle' | 'checking' | 'up-to-date' | 'update-available' | 'error'

export type UpdateCheckState = {
  status: UpdateCheckStatus
  buildSha: string | null
  source: UpdateCheckSource
  latestSha: string | null
  latestVersion: string | null
  aheadBy: number
  compareUrl: string | null
  lastCheckedAt: number | null
  nextCheckAt: number | null
  error: string | null
}

type Timer = unknown

export type UpdateCheckerDeps = {
  buildSha: string | null
  buildVersion?: string | null
  source?: UpdateCheckSource
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
type CheckResult = CompareResult & { latestSha: string | null; latestVersion: string | null }

class RateLimitError extends Error {
  constructor(readonly retryAt: number | null) {
    super('GitHub rate limit reached')
  }
}

const SHA_PATTERN = /^[0-9a-f]{40}$/i
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

export function parseVersion(value: string): string | null {
  const match = VERSION_PATTERN.exec(value.trim())
  return match ? match[0].replace(/^v/, '').replace(/\+.*$/, '') : null
}

function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === b) return 0
  if (a === undefined) return 1
  if (b === undefined) return -1
  const left = a.split('.')
  const right = b.split('.')
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const x = left[index]
    const y = right[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xNumeric = /^\d+$/.test(x)
    const yNumeric = /^\d+$/.test(y)
    if (xNumeric && yNumeric) {
      const difference = Number(x) - Number(y)
      if (difference !== 0) return Math.sign(difference)
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

export function compareVersions(a: string, b: string): number {
  const left = VERSION_PATTERN.exec(a.trim())
  const right = VERSION_PATTERN.exec(b.trim())
  if (!left || !right) return 0
  for (let index = 1; index <= 3; index += 1) {
    const difference = Number(left[index]) - Number(right[index])
    if (difference !== 0) return Math.sign(difference)
  }
  return comparePrerelease(left[4], right[4])
}

export function updateKey(state: Pick<UpdateCheckState, 'latestSha' | 'latestVersion'>): string | null {
  if (state.latestSha) return state.latestSha
  return state.latestVersion ? `v${state.latestVersion}`.toLowerCase() : null
}

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
  const source = deps.source ?? 'commits'
  const buildSha = deps.buildSha && SHA_PATTERN.test(deps.buildSha) ? deps.buildSha.toLowerCase() : null
  const buildVersion = deps.buildVersion ? parseVersion(deps.buildVersion) : null
  const enabled = deps.enabled && (source === 'releases' ? buildVersion !== null : buildSha !== null)
  const apiBase = `https://api.github.com/repos/${repository}`
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }

  let state: UpdateCheckState = {
    status: enabled ? 'idle' : 'disabled',
    buildSha,
    source,
    latestSha: null,
    latestVersion: null,
    aheadBy: 0,
    compareUrl: null,
    lastCheckedAt: null,
    nextCheckAt: null,
    error: null
  }
  const listeners = new Set<() => void>()
  let etag: string | null = null
  let cachedSha: string | null = null
  let cachedRelease: { version: string; url: string | null } | null = null
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

  async function fetchLatestRelease(): Promise<CheckResult> {
    const requestHeaders: Record<string, string> = { ...headers }
    if (etag && cachedRelease) requestHeaders['If-None-Match'] = etag
    const response = await deps.fetch(`${apiBase}/releases/latest`, { headers: requestHeaders })
    if (response.status === 304 && cachedRelease) return releaseResult(cachedRelease)
    if (response.status === 404) return { available: false, aheadBy: 0, compareUrl: null, latestSha: null, latestVersion: null }
    assertOk(response)
    const body = await response.json() as { tag_name?: unknown; html_url?: unknown }
    const version = typeof body.tag_name === 'string' ? parseVersion(body.tag_name) : null
    if (!version) throw new Error('Unexpected GitHub release response')
    etag = response.headers.get('etag')
    cachedRelease = { version, url: typeof body.html_url === 'string' ? body.html_url : null }
    return releaseResult(cachedRelease)
  }

  function releaseResult(release: { version: string; url: string | null }): CheckResult {
    const available = buildVersion !== null && compareVersions(release.version, buildVersion) > 0
    return { available, aheadBy: 0, compareUrl: available ? release.url : null, latestSha: null, latestVersion: release.version }
  }

  async function checkCommits(): Promise<CheckResult> {
    const latestSha = await fetchLatestSha()
    const result = latestSha === buildSha
      ? { available: false, aheadBy: 0, compareUrl: null }
      : await compare(latestSha)
    return { ...result, latestSha, latestVersion: null }
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
      const result = source === 'releases' ? await fetchLatestRelease() : await checkCommits()
      failures = 0
      blockedUntil = 0
      update({
        status: result.available ? 'update-available' : 'up-to-date',
        latestSha: result.latestSha,
        latestVersion: result.latestVersion,
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
