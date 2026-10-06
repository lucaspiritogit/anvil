import type { JSX } from 'react'
import { contextOccupancy } from '@anvil/protocol/task-context'
import { formatTokens } from '../format'
import { cn } from '../ui'
import { asciiBar } from './AsciiMeter'

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
  const tone = danger ? 'text-danger' : contextPercent !== null && contextPercent >= warningThreshold ? 'text-warn' : 'text-run'

  if (!compactVisible && contextPercent === null) return null

  return (
    <span aria-label="Task context controls" role="group" className="flex items-center gap-x-3 font-mono text-[11px] text-dim">
      {compactVisible && (
        <button
          type="button"
          className="inline-flex h-6 items-center px-1.5 lowercase text-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:text-faint"
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
          <span>ctx</span>
          <span aria-hidden="true" className={cn('select-none tracking-[-0.02em]', tone)}>
            {asciiBar(contextPercent / 100, 10)}
          </span>
          <span className={cn('tabular-nums', danger ? 'text-danger' : contextPercent >= warningThreshold ? 'text-warn' : 'text-fg')}>
            {contextPercent}%
          </span>
        </span>
      )}
    </span>
  )
}
