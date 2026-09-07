import type { JSX, RefObject } from 'react'
import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { ArrowDown01Icon, Cancel01Icon, Search01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import { cn, field } from '../ui'
import { ProviderIcon } from './ProviderIcon'

import { describeModel, groupModelsBySubscription, type ModelOption } from '../model-options'

export function ComposerModelPicker({ agentId, models, value, onChange, loading, error, disabled = false }: {
  agentId: string
  models: string[]
  value: string
  onChange: (model: string) => void
  loading: boolean
  error?: string
  disabled?: boolean
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const selected = describeModel(value, agentId)
  const options = useMemo(() => [...new Set(value ? [value, ...models] : models)]
    .map((model) => describeModel(model, agentId)), [agentId, models, value])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={selected.name ? `Model: ${selected.name}` : 'Choose a Model'}
        title={selected.name ? `${selected.name} · ${selected.providerName} credentials` : disabled ? 'Choose a provider first' : 'Choose a Model'}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="flex min-w-0 max-w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-45"
      >
        <ProviderIcon company={selected.company} />
        <span className="truncate">{selected.name || 'Choose a Model'}</span>
        <HugeiconsIcon icon={ArrowDown01Icon} size={12} className="shrink-0 text-dim" aria-hidden="true" />
      </button>
      {open && (
        <ModelPickerDialog
          anchorRef={triggerRef}
          agentId={agentId}
          options={options}
          value={value}
          loading={loading}
          error={error}
          allowCustom={!models.length && !loading}
          onClose={() => setOpen(false)}
          onSelect={(model) => {
            onChange(model)
            setOpen(false)
          }}
        />
      )}
    </>
  )
}

function ModelPickerDialog({ anchorRef, agentId, options, value, loading, error, allowCustom, onClose, onSelect }: {
  anchorRef: RefObject<HTMLButtonElement | null>
  agentId: string
  options: ModelOption[]
  value: string
  loading: boolean
  error?: string
  allowCustom: boolean
  onClose: () => void
  onSelect: (model: string) => void
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [customModel, setCustomModel] = useState(value)
  const search = query.trim().toLowerCase()
  const filtered = options.filter((option) =>
    `${option.name} ${option.id} ${option.company} ${option.providerName}`.toLowerCase().includes(search))
  const subscriptionGroups = groupModelsBySubscription(filtered)

  useLayoutEffect(() => {
    const dialog = dialogRef.current
    const anchor = anchorRef.current
    if (!dialog || !anchor) return
    dialog.showModal()
    searchRef.current?.focus()
    const position = (): void => {
      const bounds = anchor.getBoundingClientRect()
      const panel = dialog.getBoundingClientRect()
      const preferredTop = bounds.top - panel.height - 8
      const top = preferredTop >= 8 ? preferredTop : bounds.bottom + 8
      dialog.style.left = `${Math.max(8, Math.min(bounds.left, window.innerWidth - panel.width - 8))}px`
      dialog.style.top = `${Math.max(8, Math.min(top, window.innerHeight - panel.height - 8))}px`
    }
    position()
    window.addEventListener('resize', position)
    return () => {
      window.removeEventListener('resize', position)
      dialog.close()
      if (anchor.isConnected) anchor.focus()
    }
  }, [anchorRef])

  return (
    <dialog
      ref={dialogRef}
      aria-label="Choose model"
      className="fixed m-0 h-[min(400px,calc(100dvh-16px))] max-h-none w-[min(420px,calc(100vw-16px))] max-w-none overflow-hidden rounded-xl border border-line bg-raised p-0 text-fg shadow-[0_16px_64px_rgba(0,0,0,0.5)] backdrop:bg-black/20"
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault()
        }
        if (event.key === 'Tab') {
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')]
          const first = controls[0]
          const last = controls.at(-1)
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last?.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first?.focus()
          }
        }
      }}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return
        const bounds = event.currentTarget.getBoundingClientRect()
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose()
      }}
    >
      <div className="flex h-full">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="mx-3 flex items-center gap-2 border-b border-line focus-within:border-accent">
            <HugeiconsIcon icon={Search01Icon} size={16} className="shrink-0 text-dim" aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              aria-label="Search models"
              placeholder="Search models…"
              className="min-w-0 flex-1 bg-transparent py-3.5 text-xs outline-none placeholder:text-dim"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  listRef.current?.querySelector('button')?.focus()
                }
              }}
            />
            <button type="button" aria-label="Close model picker" className="rounded p-1 text-dim hover:bg-hover hover:text-fg focus-visible:outline-accent" onClick={onClose}>
              <HugeiconsIcon icon={Cancel01Icon} size={14} aria-hidden="true" />
            </button>
          </div>
          <div
            ref={listRef}
            role="group"
            aria-label="Models"
            aria-busy={loading}
            className="min-h-0 flex-1 overflow-y-auto p-2"
            onKeyDown={(event) => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
              const buttons = [...event.currentTarget.querySelectorAll('button')]
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
              if (index < 0) return
              event.preventDefault()
              const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
              buttons[nextIndex]?.focus()
            }}
          >
            {agentId === 'opencode' ? subscriptionGroups.map((group) => (
              <div key={group.id} role="group" aria-label={group.id === 'other' ? group.title : `${group.title} models`} className="border-t border-line pb-2 first:border-t-0 last:pb-0">
                <h3 className="px-3 pb-2 pt-3 text-[11px] font-medium text-dim">{group.title}</h3>
                {group.models.map((option) => (
                  <ModelRow key={option.id} option={option} selected={option.id === value} onSelect={onSelect} />
                ))}
              </div>
            )) : filtered.map((option) => (
              <ModelRow key={option.id} option={option} selected={option.id === value} onSelect={onSelect} />
            ))}
            {loading && <p role="status" className="px-3 py-4 text-xs text-dim">Loading models…</p>}
            {!loading && !filtered.length && (
              <p role="status" className="px-3 py-6 text-center text-xs text-dim">{search ? 'No models match your search.' : 'No models listed by this agent.'}</p>
            )}
          </div>
          {allowCustom && (
            <div className="border-t border-line px-3 py-2">
              <label className="block text-[11px] text-dim">
                Custom model
                <input
                  className={cn(field.sized, 'mt-1 text-xs')}
                  placeholder="provider/model"
                  value={customModel}
                  onChange={(event) => setCustomModel(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && customModel.trim()) {
                      event.preventDefault()
                      onSelect(customModel.trim())
                    }
                  }}
                />
              </label>
              <button type="button" disabled={!customModel.trim()} className="mt-2 text-xs text-accent disabled:opacity-45" onClick={() => onSelect(customModel.trim())}>Use custom model</button>
            </div>
          )}
          <div className="border-t border-line px-4 py-2 text-[11px] text-dim">
            {error ? <p role="status">Could not list models: {error}</p> : `${filtered.length} ${filtered.length === 1 ? 'model' : 'models'}`}
          </div>
        </div>
      </div>
    </dialog>
  )
}

function ModelRow({ option, selected, onSelect }: {
  option: ModelOption
  selected: boolean
  onSelect: (model: string) => void
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={option.name}
      aria-description={`Uses ${option.providerName} credentials`}
      aria-pressed={selected}
      title={option.id}
      onClick={() => onSelect(option.id)}
      className={cn('mb-1 flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-hover focus-visible:bg-hover focus-visible:outline-2 focus-visible:outline-accent', selected && 'bg-hover')}
    >
      <ProviderIcon company={option.company} size={16} />
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{option.name}</span>
      {selected && <HugeiconsIcon icon={Tick02Icon} size={16} className="shrink-0 text-accent" aria-hidden="true" />}
    </button>
  )
}
