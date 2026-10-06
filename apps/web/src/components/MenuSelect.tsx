import type { JSX, KeyboardEvent, ReactNode } from 'react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Icon, type IconName } from '../icons'
import { cn } from '../ui'

export type MenuSelectOption<T extends string = string> = {
  value: T
  label: string
  description?: string
  icon?: IconName
  meter?: { level: number; max: number }
  disabled?: boolean
}

const SEARCH_THRESHOLD = 8

export function MenuSelect<T extends string>({ label, title, aside, value, options, onChange, icon, placeholder, disabled, describedBy, searchable, className }: {
  label: string
  title?: string
  aside?: ReactNode
  value: T
  options: MenuSelectOption<T>[]
  onChange: (value: T) => void
  icon?: IconName
  placeholder?: string
  disabled?: boolean
  describedBy?: string
  searchable?: boolean
  className?: string
}): JSX.Element {
  const menuId = useId()
  const listId = `${menuId}-list`
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(-1)
  const selected = options.find((option) => option.value === value)
  const withSearch = searchable ?? options.length > SEARCH_THRESHOLD
  const search = query.trim().toLowerCase()
  const visible = withSearch && search ? options.filter((option) => option.label.toLowerCase().includes(search)) : options
  const triggerIcon = selected?.icon ?? icon
  const optionId = (index: number): string => `${listId}-${index}`

  const enabledIndex = (from: number, step: 1 | -1): number => {
    for (let index = from; index >= 0 && index < visible.length; index += step) {
      if (!visible[index].disabled) return index
    }
    return -1
  }

  const position = (): void => {
    const trigger = triggerRef.current
    const menu = menuRef.current
    if (!trigger || !menu) return
    const bounds = trigger.getBoundingClientRect()
    const layoutWidth = Number.parseFloat(window.getComputedStyle(menu).width)
    const zoom = menu.getBoundingClientRect().width / layoutWidth || 1
    menu.style.minWidth = `${bounds.width / zoom}px`
    menu.style.maxWidth = `${Math.max(0, window.innerWidth - 16) / zoom}px`
    const panel = menu.getBoundingClientRect()
    const below = bounds.bottom + 6
    const above = bounds.top - panel.height - 6
    const top = below + panel.height <= window.innerHeight - 8 || above < 8 ? below : above
    const left = Math.max(8, Math.min(bounds.left, window.innerWidth - panel.width - 8))
    menu.style.left = `${left / zoom}px`
    menu.style.top = `${Math.max(8, Math.min(top, window.innerHeight - panel.height - 8)) / zoom}px`
  }

  const show = (): void => {
    const menu = menuRef.current
    if (disabled || !options.length || !menu) return
    setQuery('')
    const current = options.findIndex((option) => option.value === value && !option.disabled)
    setActive(current >= 0 ? current : options.findIndex((option) => !option.disabled))
    if (!menu.matches(':popover-open')) menu.showPopover()
    setOpen(true)
    position()
    const focusTarget = withSearch ? searchRef.current : listRef.current
    focusTarget?.focus({ preventScroll: true })
  }

  const close = (restoreFocus: boolean): void => {
    const menu = menuRef.current
    if (menu?.matches(':popover-open')) menu.hidePopover()
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true })
  }

  const pick = (option: MenuSelectOption<T> | undefined): void => {
    if (!option || option.disabled) return
    close(true)
    if (option.value !== value) onChange(option.value)
  }

  useLayoutEffect(() => {
    const trigger = triggerRef.current
    const menu = menuRef.current
    if (!open || !trigger || !menu) return
    position()
    const observer = new ResizeObserver(position)
    observer.observe(trigger)
    observer.observe(menu)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open])

  useEffect(() => {
    if (!open || active < 0) return
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  useEffect(() => {
    if (disabled && open) close(false)
  }, [disabled, open])

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault()
      event.stopPropagation()
      close(true)
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      const next = enabledIndex(active < 0 ? (step === 1 ? 0 : visible.length - 1) : active + step, step)
      if (next >= 0) setActive(next)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      if (event.currentTarget === searchRef.current) return
      event.preventDefault()
      const next = event.key === 'Home' ? enabledIndex(0, 1) : enabledIndex(visible.length - 1, -1)
      if (next >= 0) setActive(next)
      return
    }
    if (event.key === 'Enter' || (event.key === ' ' && event.currentTarget !== searchRef.current)) {
      event.preventDefault()
      pick(visible[active])
      return
    }
    if (event.currentTarget === searchRef.current || event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return
    const letter = event.key.toLowerCase()
    const start = active + 1
    const order = [...visible.slice(start).map((_, offset) => start + offset), ...visible.slice(0, start).map((_, index) => index)]
    const match = order.find((index) => !visible[index].disabled && visible[index].label.toLowerCase().startsWith(letter))
    if (match !== undefined) setActive(match)
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-describedby={describedBy}
        disabled={disabled}
        className={cn(
          'flex h-[30px] min-w-0 max-w-full shrink-0 items-center gap-2 border px-2 font-mono text-xs text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:border-line disabled:bg-raised disabled:text-faint',
          open ? 'border-accent bg-hover' : 'border-line-strong bg-overlay hover:border-dim hover:bg-hover',
          className
        )}
        popoverTarget={menuId}
        onClick={(event) => {
          event.preventDefault()
          if (menuRef.current?.matches(':popover-open')) close(false)
          else show()
        }}
        onKeyDown={(event) => {
          if (open || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
          event.preventDefault()
          show()
        }}
      >
        {triggerIcon && <Icon icon={triggerIcon} size={16} className="shrink-0 text-dim" aria-hidden="true" />}
        <span className="min-w-0 truncate">{selected?.label ?? placeholder}</span>
        <Icon icon="chevron-down" size={12} className={cn('shrink-0 transition-transform duration-[120ms] motion-reduce:transition-none', open ? 'rotate-180 text-accent' : 'text-dim')} aria-hidden="true" />
      </button>
      <div
        ref={menuRef}
        id={menuId}
        popover="auto"
        className="menu-select-panel fixed m-0 w-max max-w-[calc(100vw-16px)] border border-line-strong bg-overlay p-0 text-left text-fg shadow-[0_0_0_1px_var(--color-void)]"
        onToggle={(event) => {
          if (event.newState === 'closed') setOpen(false)
        }}
      >
        <div className="flex items-center justify-between gap-4 border-b border-line px-3 py-2">
          <span className="font-mono text-[10px] font-medium tracking-[0.12em] uppercase text-dim">{title ?? label}</span>
          {aside && <span className="min-w-0 truncate font-mono text-[10px] text-faint">{aside}</span>}
        </div>
        {withSearch && (
          <div className="flex h-[34px] items-center gap-2 border-b border-line px-3">
            <span aria-hidden="true" className="font-mono text-xs text-ember-400">›</span>
            <input
              ref={searchRef}
              type="text"
              aria-label="Filter options"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={active >= 0 ? optionId(active) : undefined}
              className="min-w-0 flex-1 bg-transparent font-mono text-xs text-fg outline-none placeholder:text-faint"
              placeholder="Filter…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setActive(0)
              }}
              onKeyDown={onKeyDown}
            />
            <span className="font-mono text-[10px] text-faint">{visible.length} / {options.length}</span>
          </div>
        )}
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={label}
          tabIndex={withSearch ? undefined : -1}
          aria-activedescendant={!withSearch && active >= 0 ? optionId(active) : undefined}
          className="max-h-72 overflow-y-auto py-1 outline-none"
          onKeyDown={withSearch ? undefined : onKeyDown}
        >
          {visible.map((option, index) => {
            const isSelected = option.value === value
            const meter = option.meter
            return (
              <div
                key={option.value}
                id={optionId(index)}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
                aria-labelledby={`${optionId(index)}-label`}
                aria-describedby={option.description ? `${optionId(index)}-description` : undefined}
                className={cn(
                  'flex gap-2.5 px-3',
                  option.description ? 'items-start py-2.5' : 'items-center py-[7px]',
                  option.disabled ? 'cursor-not-allowed text-faint' : 'cursor-pointer text-fg',
                  index === active && !option.disabled && 'row-selected'
                )}
                onMouseMove={() => {
                  if (!option.disabled && index !== active) setActive(index)
                }}
                onClick={() => pick(option)}
              >
                {option.icon && <Icon icon={option.icon} size={16} className={cn('shrink-0', option.description && 'mt-px', option.disabled ? 'text-faint' : 'text-dim')} aria-hidden="true" />}
                <span className="min-w-0 flex-1">
                  <span id={`${optionId(index)}-label`} className={cn('block truncate', option.description ? 'text-[13px] font-medium' : 'font-mono text-xs')}>{option.label}</span>
                  {option.description && <span id={`${optionId(index)}-description`} className={cn('mt-0.5 block max-w-72 text-xs leading-snug', option.disabled ? 'text-faint' : 'text-dim')}>{option.description}</span>}
                </span>
                {meter && (
                  <span aria-hidden="true" className="flex shrink-0 gap-px">
                    {Array.from({ length: meter.max }, (_, cell) => <span key={cell} className={cn('h-2.5 w-1', cell < meter.level ? 'bg-ember-400' : 'bg-line-strong')} />)}
                  </span>
                )}
                <span aria-hidden="true" className={cn("w-3 shrink-0 font-mono text-xs text-ember-400 after:content-['✓']", !isSelected && 'invisible')} />
              </div>
            )
          })}
          {!visible.length && <p className="px-3 py-2 font-mono text-xs text-faint">No matches</p>}
        </div>
        <div aria-hidden="true" className="flex gap-3.5 border-t border-dashed border-line px-3 py-[7px] font-mono text-[10px] text-faint">
          <span>↑↓ move</span><span>↵ select</span><span>esc close</span>
        </div>
      </div>
    </>
  )
}
