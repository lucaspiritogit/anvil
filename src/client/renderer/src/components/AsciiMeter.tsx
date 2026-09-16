import type { JSX } from 'react'
import type { DitherColor } from '@dither-kit/palette'
import { cn } from '../ui'

export const ASCII_METER_TONE = {
  blue: 'text-accent',
  green: 'text-ok',
  purple: 'text-violet',
  pink: 'text-violet',
  red: 'text-danger',
  orange: 'text-warn',
  grey: 'text-dim'
} satisfies Record<DitherColor, string>

export function asciiBar(ratio: number, width: number): string {
  const bounded = Math.max(0, Math.min(1, ratio))
  const filled = Math.round(bounded * width)
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

export function AsciiMeter({
  label,
  value,
  ratio,
  tone = 'blue',
  width = 24,
  className,
  percentLabel
}: {
  label: string
  value: string
  ratio: number
  tone?: keyof typeof ASCII_METER_TONE
  width?: number
  className?: string
  percentLabel?: string
}): JSX.Element {
  const pct = Math.round(Math.max(0, Math.min(1, ratio)) * 100)
  return (
    <div className={cn('grid gap-1', className)}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="truncate text-muted-foreground">{label}</span>
        <span className="tabular-nums">{value}</span>
      </div>
      <div
        className="flex items-center gap-2"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label={label}
      >
        <span className={cn('truncate text-[11px] leading-none tracking-[-0.04em] select-none', ASCII_METER_TONE[tone])}>
          {asciiBar(ratio, width)}
        </span>
        <span className="min-w-9 shrink-0 text-right text-[10px] text-muted-foreground tabular-nums">{percentLabel ?? `${pct}%`}</span>
      </div>
    </div>
  )
}
