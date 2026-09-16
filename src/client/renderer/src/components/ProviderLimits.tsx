import type { JSX } from 'react'
import { AsciiMeter } from './AsciiMeter'
import { ProviderIcon } from './ProviderIcon'
import { cn } from '../ui'

export interface ProviderLimit {
  label: string
  value: string
  remainingPercent: number
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
    <div className={cn('w-full max-w-[1040px] mx-auto', className)}>
      {providers.map((provider) => (
        <section
          key={provider.id}
          aria-label={provider.ariaLabel}
          className="flex items-center gap-4 border-t border-dashed border-line/70 px-1 pt-4 max-[700px]:gap-3"
        >
          <div className="flex shrink-0 items-center gap-2 text-xs font-medium text-foreground">
            <ProviderIcon company={provider.company} size={18} />
            <span>{provider.name}</span>
          </div>
          <div className="grid min-w-0 flex-1 gap-3">
            {provider.limits.map((limit) => (
              <AsciiMeter
                key={limit.label}
                label={limit.label}
                value={limit.value}
                ratio={limit.remainingPercent / 100}
                width={24}
                percentLabel={`${Math.round(limit.remainingPercent)}% left`}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
