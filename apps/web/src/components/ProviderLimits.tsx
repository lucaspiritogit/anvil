import type { JSX } from 'react'
import { ProviderIcon } from './ProviderIcon'
import { cn } from '../ui'

const METER_CELLS = 8

function meterTone(remainingPercent: number): string {
  if (remainingPercent <= 10) return 'bg-danger'
  if (remainingPercent <= 25) return 'bg-warn'
  return 'bg-accent'
}

function filledCells(remainingPercent: number): number {
  return Math.round(Math.max(0, Math.min(100, remainingPercent)) / 100 * METER_CELLS)
}

function LimitMeter({ label, remainingPercent }: { label: string; remainingPercent: number }): JSX.Element {
  const filled = filledCells(remainingPercent)
  return (
    <span
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(remainingPercent)}
      aria-label={label}
      className="grid h-2.5 w-12 shrink-0 gap-px"
      style={{ gridTemplateColumns: `repeat(${METER_CELLS}, minmax(0, 1fr))` }}
    >
      {Array.from({ length: METER_CELLS }, (_, cell) => <span key={cell} aria-hidden="true" className={cell < filled ? meterTone(remainingPercent) : 'bg-line'} />)}
    </span>
  )
}

export interface ProviderLimit {
  label: string
  shortLabel: string
  value: string
  reset: string | null
  remainingPercent: number | null
}

export interface ProviderLimitsData {
  id: string
  name: string
  company: string
  ariaLabel: string
  limits: ProviderLimit[]
}

export function ProviderLimits({ providers, className }: {
  providers: ProviderLimitsData[]
  className?: string
}): JSX.Element | null {
  if (!providers.length) return null

  return (
    <div
      aria-label="Usage"
      role="group"
      className={cn('mx-auto flex w-full max-w-[1040px] flex-wrap items-center gap-x-6 gap-y-1.5 border-t border-dashed border-line-strong pt-2.5 font-mono text-[11px] text-dim animate-fade-in', className)}
    >
      <span className="tracking-[0.12em] text-faint uppercase">Usage</span>
      {providers.map((provider) => (
        <section key={provider.id} aria-label={provider.ariaLabel} className="flex min-w-0 items-center gap-x-3.5 gap-y-1 max-[700px]:flex-wrap">
          <span className="flex items-center gap-1.5 text-fg">
            <ProviderIcon company={provider.company} size={12} />
            <span>{provider.name}</span>
          </span>
          {provider.limits.map((limit) => (
            <span key={limit.label} title={limit.remainingPercent === null ? undefined : `${limit.label}: ${limit.value}`} className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="sr-only">{limit.label}: {limit.value}</span>
              <span aria-hidden="true" className="text-faint">{limit.shortLabel}</span>
              {limit.remainingPercent === null
                ? <span aria-hidden="true" className="text-faint">n/a</span>
                : <>
                  <LimitMeter label={limit.label} remainingPercent={limit.remainingPercent} />
                  <span className="tabular-nums text-fg">{Math.round(limit.remainingPercent)}% left</span>
                  {limit.reset && <span aria-hidden="true" className="text-faint max-[1180px]:hidden">↻ {limit.reset}</span>}
                </>}
            </span>
          ))}
        </section>
      ))}
    </div>
  )
}
