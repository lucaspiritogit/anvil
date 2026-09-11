import type { JSX, ReactNode, RefObject } from 'react'
import { useRef, useState } from 'react'
import { Icon } from '../icons'
import { cn } from '../ui'
import { PickerDialog } from './PickerDialog'

export interface PickerChoice {
  id: string
  label: string
  description?: string
  icon?: ReactNode
  disabled?: boolean
}

export function ChoicePickerDialog({ anchorRef, label, noun, choices, value, onSelect, onClose }: {
  anchorRef: RefObject<HTMLButtonElement | null>
  label: string
  noun: string
  choices: PickerChoice[]
  value: string
  onSelect: (id: string) => void
  onClose: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const filtered = choices.filter((choice) => `${choice.label} ${choice.id}`.toLowerCase().includes(query.trim().toLowerCase()))

  return (
    <PickerDialog anchorRef={anchorRef} label={label} onClose={onClose}>
      <div className="flex h-full flex-col">
        <div className="mx-3 flex items-center gap-2 border-b border-line focus-within:border-accent">
          <Icon icon="search" size={16} className="shrink-0 text-dim" aria-hidden="true" />
          <input
            type="search"
            aria-label={`Search ${noun}`}
            placeholder={`Search ${noun}…`}
            className="min-w-0 flex-1 bg-transparent py-3.5 text-xs outline-none placeholder:text-dim"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                listRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
              }
            }}
          />
          <button type="button" aria-label={`Close ${noun} picker`} className="p-1 text-dim hover:bg-hover hover:text-fg focus-visible:outline-accent" onClick={onClose}>
            <Icon icon="x" size={14} aria-hidden="true" />
          </button>
        </div>
        <div
          ref={listRef}
          role="group"
          aria-label={noun}
          className="min-h-0 flex-1 overflow-y-auto p-2"
          onKeyDown={(event) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
            const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
            if (index < 0) return
            event.preventDefault()
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
              : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
            buttons[next]?.focus()
          }}
        >
          {filtered.map((choice) => (
            <button
              key={choice.id}
              type="button"
              aria-label={choice.label}
              aria-description={choice.description}
              aria-pressed={choice.id === value}
              disabled={choice.disabled}
              title={choice.label}
              onClick={() => onSelect(choice.id)}
              className={cn('mb-1 flex w-full items-center gap-3 px-3 py-3 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-45', choice.id === value && 'bg-hover')}
            >
              {choice.icon}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium">{choice.label}</span>
                {choice.description && <span className="block text-[11px] text-dim">{choice.description}</span>}
              </span>
              {choice.id === value && <Icon icon="check" size={16} className="shrink-0 text-accent" aria-hidden="true" />}
            </button>
          ))}
          {!filtered.length && <p role="status" className="px-3 py-6 text-center text-xs text-dim">No {noun} match your search.</p>}
        </div>
      </div>
    </PickerDialog>
  )
}
