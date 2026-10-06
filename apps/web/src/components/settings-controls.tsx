import type { JSX, ReactNode } from 'react'
import { useId } from 'react'
import { cn, field } from '../ui'

export function SettingsPanel({ title, aside, tone, className, children }: {
  title: ReactNode
  aside?: ReactNode
  tone?: 'danger'
  className?: string
  children: ReactNode
}): JSX.Element {
  const id = useId()
  return (
    <section aria-labelledby={id} className={cn('mb-6 border', tone === 'danger' ? 'border-danger/40 bg-danger-tint/50' : 'border-line bg-raised', className)}>
      <div className={cn('flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-4 py-2.5', tone === 'danger' ? 'border-danger/25' : 'border-line')}>
        <h3 id={id} className={cn('font-mono text-[11px] font-medium tracking-[0.12em] uppercase', tone === 'danger' ? 'text-danger-text' : 'text-dim')}>{title}</h3>
        {aside && <div className="min-w-0 text-[11px] text-faint">{aside}</div>}
      </div>
      <div className="divide-y divide-line">{children}</div>
    </section>
  )
}

export function SettingRow({ title, description, disabled, children, below }: {
  title: ReactNode
  description?: ReactNode
  disabled?: boolean
  children?: ReactNode
  below?: ReactNode
}): JSX.Element {
  return (
    <div className={cn('px-4 py-3.5', disabled && 'opacity-50')}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-[1_1_240px]">
          <div className="text-sm font-medium">{title}</div>
          {description && <div className="mt-1 text-xs leading-normal text-dim">{description}</div>}
        </div>
        {children && <div className="flex min-w-0 max-w-full shrink-0 flex-wrap items-center gap-2">{children}</div>}
      </div>
      {below}
    </div>
  )
}

export function Switch({ checked, disabled, onChange, label, labelledBy }: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  label?: string
  labelledBy?: string
}): JSX.Element {
  return (
    <span className={cn('relative inline-flex h-5 w-9 shrink-0 items-center border p-[2px] transition-colors duration-[120ms] motion-reduce:transition-none',
      checked ? 'justify-end border-accent bg-ember-950' : 'justify-start border-line-strong bg-canvas',
      'has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
      disabled && 'opacity-50')}>
      <input type="checkbox" aria-label={label} aria-labelledby={labelledBy} className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
        checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span aria-hidden="true" className={cn('pointer-events-none size-3.5', checked ? 'bg-accent' : 'bg-faint')} />
    </span>
  )
}

/**
 * The one settings checkbox row: the box stays centred against a title with
 * an optional description beneath it, so every toggle in a section lines up —
 * no more bare flex rows mixed with modal.toggle cards.
 */
export function ToggleRow({ title, description, checked, disabled, onChange, children }: {
  title: ReactNode
  description?: ReactNode
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  /** Extra content (warnings, follow-up notes) rendered under the description. */
  children?: ReactNode
}): JSX.Element {
  return (
    <label className={cn('flex cursor-pointer items-center justify-between gap-6 px-4 py-3.5', disabled && 'cursor-not-allowed opacity-60')}>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        {description && <small className="mt-1 block text-xs leading-normal text-dim">{description}</small>}
        {children}
      </span>
      <Switch checked={checked} disabled={disabled} onChange={onChange} />
    </label>
  )
}

export type OptionCardsOption = {
  value: string
  label: string
  description?: string
}

/**
 * Radio cards for a choice whose options each carry their own description.
 * Keeps the label and its description as separate lines instead of cramming
 * 'Label — description' into one <option> string.
 */
export function OptionCards({ options, value, onChange, name, disabled, ariaLabel }: {
  options: OptionCardsOption[]
  value: string
  onChange: (value: string) => void
  /** Radio group name; one is generated when omitted. */
  name?: string
  disabled?: boolean
  ariaLabel?: string
}): JSX.Element {
  const generatedName = useId()
  const groupName = name ?? generatedName
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="grid gap-2 px-4 py-3.5">
      {options.map((option) => {
        const selected = option.value === value
        return (
          <label
            key={option.value}
            className={cn(
              'relative flex items-start gap-3 border px-3.5 py-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-accent',
              selected ? 'border-accent bg-ember-950' : 'border-line-strong bg-canvas hover:border-dim',
              disabled ? 'opacity-45' : 'cursor-pointer'
            )}
          >
            <input
              type="radio"
              className="absolute inset-0 m-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
              name={groupName}
              value={option.value}
              checked={selected}
              disabled={disabled}
              onChange={() => onChange(option.value)}
            />
            <span aria-hidden="true" className={cn('mt-[3px] grid size-3.5 flex-none place-items-center border', selected ? 'border-accent' : 'border-faint')}>
              <span className={cn('size-1.5', selected && 'bg-accent')} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium">{option.label}</span>
              {option.description && <small className={field.hint}>{option.description}</small>}
            </span>
          </label>
        )
      })}
    </div>
  )
}
