import type { Run } from '@shared/types'

/**
 * Run metrics are rendered in the sidebar, the task list and the run header,
 * so the formatting lives here rather than drifting between the three.
 */

/** Wall time so far: `now` keeps a running task ticking. */
export function formatDuration(run: Run, now: number): string {
  const seconds = Math.max(0, Math.floor(((run.endedAt ?? now) - run.startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

export function formatTokens(tokens: number): string {
  return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(tokens)
}

/** Agents that never report a price get `null`, which is not the same as $0. */
export function formatCost(costUsd: number | null): string {
  if (costUsd === null) return 'n/a'
  return `$${costUsd.toFixed(costUsd < 0.01 ? 4 : 2)}`
}

/** Input/output/cached split, for the tooltip behind a token total. */
export function tokenBreakdown(run: Run): string {
  return [
    `${run.inputTokens.toLocaleString()} input`,
    `${run.outputTokens.toLocaleString()} output`,
    `${run.cachedTokens.toLocaleString()} cached`
  ].join(', ')
}
