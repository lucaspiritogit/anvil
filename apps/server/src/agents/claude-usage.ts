import type { ClaudeRateLimits, ClaudeRateLimitWindow } from '@anvil/protocol/types'

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Claude usage response')
  return value as Record<string, unknown>
}

function window(value: unknown): ClaudeRateLimitWindow | null {
  if (value === undefined || value === null) return null
  const limit = record(value)
  const usedPercent = 'utilization' in limit ? limit.utilization : limit.percent
  if (usedPercent === null) return null
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent)) throw new Error('Invalid Claude usage percentage')
  let resetsAt: number | null = null
  if (limit.resets_at !== undefined && limit.resets_at !== null) {
    if (typeof limit.resets_at === 'number' && Number.isFinite(limit.resets_at)) resetsAt = limit.resets_at
    else if (typeof limit.resets_at === 'string') {
      const parsed = Date.parse(limit.resets_at)
      if (!Number.isFinite(parsed)) throw new Error('Invalid Claude usage reset time')
      resetsAt = parsed / 1000
    } else throw new Error('Invalid Claude usage reset time')
  }
  return { usedPercent: Math.max(0, Math.min(100, usedPercent)), resetsAt }
}

function fable(value: unknown): boolean {
  return typeof value === 'string' && value.toLowerCase() === 'fable'
}

export function parseClaudeRateLimits(value: unknown): ClaudeRateLimits {
  const usage = record(value)
  const empty: ClaudeRateLimits = { fiveHour: null, weeklyAll: null, weeklyFable: null }
  if (usage.rate_limits_available === false || usage.rate_limits === null) return empty
  const limits = record(usage.rate_limits)
  const entries = Array.isArray(limits.limits) ? limits.limits.map(record) : []
  const scoped = Array.isArray(limits.model_scoped) ? limits.model_scoped.map(record) : []
  const fableLimit = scoped.find((entry) => fable(entry.display_name)) ?? entries.find((entry) => {
    if (entry.kind !== 'weekly_scoped' || !entry.scope || typeof entry.scope !== 'object') return false
    const model = (entry.scope as Record<string, unknown>).model
    return !!model && typeof model === 'object' && fable((model as Record<string, unknown>).display_name)
  })
  return {
    fiveHour: window(limits.five_hour ?? entries.find((entry) => entry.kind === 'session')),
    weeklyAll: window(limits.seven_day ?? entries.find((entry) => entry.kind === 'weekly_all')),
    weeklyFable: window(fableLimit)
  }
}
