import type { JSX, SelectHTMLAttributes } from 'react'
import { Icon } from '../icons'
import { cn, field } from '../ui'

/**
 * A native <select> (kept for keyboard and screen-reader behaviour) with the
 * platform caret replaced by a chevron centred in its own right-hand padding,
 * so every picker lines up no matter how the OS draws the default widget.
 * Takes the same props and <option> children a plain <select> would.
 */
export function Select({ className, children, disabled, ...props }: SelectHTMLAttributes<HTMLSelectElement>): JSX.Element {
  return (
    <span className="relative block">
      <select
        className={cn(field.sized, 'appearance-none pr-9 disabled:cursor-not-allowed disabled:opacity-45', className)}
        disabled={disabled}
        {...props}
      >
        {children}
      </select>
      <Icon
        icon="chevron-down"
        size={14}
        className={cn('pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-dim', disabled && 'opacity-45')}
        aria-hidden="true"
      />
    </span>
  )
}
