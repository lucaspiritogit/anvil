import type { JSX } from 'react'
import { contextOccupancy } from '@shared/task-context'
import { formatTokens } from '../format'
import { btn, cn } from '../ui'

export interface TaskContextControlProps {
  compactVisible: boolean
  busy: boolean
  disabled: boolean
  error: string
  contextUsed?: number | null
  contextSize?: number | null
  warningThreshold?: number
  danger: boolean
  onCompact: () => void
}

/** Compaction action and the context-window occupancy it acts on. */
export function TaskContextControl({
  compactVisible,
  busy,
  disabled,
  error,
  contextUsed,
  contextSize,
  warningThreshold = 75,
  danger,
  onCompact
}: TaskContextControlProps): JSX.Element | null {
  const occupancy = contextOccupancy(contextUsed, contextSize)
  const contextPercent = occupancy.contextSize !== null && occupancy.contextUsed !== null
    ? Math.round(occupancy.contextUsed / occupancy.contextSize * 100)
    : null

  if (!compactVisible && contextPercent === null && !error) return null

  return (
    <div className="mb-1.5">
      <div aria-label="Task context controls" role="group" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-dim">
        {compactVisible && (
          <button
            type="button"
            className={cn(btn.ghost, 'px-2 py-0.5 text-[11px]')}
            disabled={disabled}
            title="Summarize earlier model history in this task's session"
            onClick={onCompact}
          >
            {busy ? 'Compacting…' : 'Compact'}
          </button>
        )}
        {contextPercent !== null && (
          <span
            className="flex items-baseline gap-x-1.5 whitespace-nowrap"
            title={`${formatTokens(occupancy.contextUsed!)} / ${formatTokens(occupancy.contextSize!)} in the current session. Token totals are billed usage, not window fill.`}
          >
            <span>Context</span>
            <span className={cn('font-medium tabular-nums', danger ? 'text-danger' : contextPercent >= warningThreshold ? 'text-warn' : 'text-fg')}>
              {contextPercent}%
            </span>
          </span>
        )}
      </div>
      {error && <p role="alert" className="mt-1.5 max-h-16 overflow-y-auto text-xs text-danger">{error}</p>}
    </div>
  )
}
