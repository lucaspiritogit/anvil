import type { JSX } from 'react'
import { asciiBar } from './AsciiMeter'
import { ProviderIcon } from './ProviderIcon'
import { cn } from '../ui'

const METER_CELLS = 32

function meterTone(remainingPercent: number): string {
  if (remainingPercent <= 10) return 'text-danger'
  if (remainingPercent <= 25) return 'text-warn'
  return 'text-accent'
}

export interface ProviderLimit {
  label: string
  value: string
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
      className={cn('mx-auto grid w-full max-w-[1040px] gap-x-8 gap-y-6 animate-fade-in', className)}
      style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))' }}
    >
      {providers.map((provider) => (
        <section
          key={provider.id}
          aria-label={provider.ariaLabel}
          className="min-w-0 border-t border-dashed border-line-strong pt-4"
        >
          <div className="mb-3.5 flex items-center gap-2 font-mono text-[11px] font-medium tracking-[0.12em] text-fg uppercase">
            <ProviderIcon company={provider.company} size={16} />
            <span>{provider.name}</span>
          </div>
          <div className="grid min-w-0 gap-3.5">
            {provider.limits.map((limit) => (
              <div key={limit.label} className="grid gap-1.5 font-mono">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs">
                  <span className="text-dim">{limit.label}</span>
                  <span className="text-dim tabular-nums">{limit.value}</span>
                </div>
                {limit.remainingPercent !== null && <div
                  className="flex items-center gap-3"
                  role="meter"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(limit.remainingPercent)}
                  aria-label={limit.label}
                >
                  <span
                    className={cn('grid min-w-0 flex-1 select-none text-[13px] leading-none', meterTone(limit.remainingPercent))}
                    style={{ gridTemplateColumns: `repeat(${METER_CELLS}, minmax(0, 1fr))` }}
                    aria-hidden="true"
                  >
                    {asciiBar(limit.remainingPercent / 100, METER_CELLS).split('').map((character, index) => (
                      <span key={index} className="text-center">{character}</span>
                    ))}
                  </span>
                  <span className="min-w-16 shrink-0 text-right text-[11px] text-fg tabular-nums">
                    {Math.round(limit.remainingPercent)}% left
                  </span>
                </div>}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
