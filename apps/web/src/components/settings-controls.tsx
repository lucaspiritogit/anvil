import type { JSX, ReactNode } from 'react'
import { useId } from 'react'
import { cn, field } from '../ui'

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
    <label className={cn('mb-3 flex items-center gap-3 border border-line p-3', disabled && 'opacity-60')}>
      <input
        type="checkbox"
        className="flex-none"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0">
        <span className="block">{title}</span>
        {description && <small className={field.hint}>{description}</small>}
        {children}
      </span>
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
    <div role="radiogroup" aria-label={ariaLabel} className="mb-3 grid gap-2">
      {options.map((option) => {
        const selected = option.value === value
        return (
          <label
            key={option.value}
            className={cn(
              'flex items-start gap-3 border p-3 focus-within:outline-2 focus-within:outline-accent',
              selected ? 'border-accent bg-accent/10' : 'border-line hover:border-dim',
              disabled ? 'opacity-45' : 'cursor-pointer'
            )}
          >
            <input
              type="radio"
              className="mt-0.5 flex-none"
              name={groupName}
              value={option.value}
              checked={selected}
              disabled={disabled}
              onChange={() => onChange(option.value)}
            />
            <span className="min-w-0">
              <span className="block">{option.label}</span>
              {option.description && <small className={field.hint}>{option.description}</small>}
            </span>
          </label>
        )
      })}
    </div>
  )
}
