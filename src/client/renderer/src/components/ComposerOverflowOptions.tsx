import type { JSX, ReactNode, RefObject } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { Icon } from '../icons'

export function ComposerOverflowOptions({ children, containerRef }: {
  children: ReactNode
  containerRef: RefObject<HTMLFormElement | null>
}): JSX.Element {
  const popoverId = useId()
  const popoverRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    // Close when the sidebar or window moves the trigger, including when the
    // inline controls replace it. A native popover otherwise stays in the top layer.
    const observer = new ResizeObserver(() => popoverRef.current?.hidePopover())
    observer.observe(container)
    return () => observer.disconnect()
  }, [containerRef])

  return (
    <div className="shrink-0">
      <div className="hidden items-center gap-1 @min-[640px]/composer:flex">{children}</div>
      <button
        ref={triggerRef}
        type="button"
        popoverTarget={popoverId}
        aria-label="More task options"
        aria-expanded={open}
        title="Reasoning effort"
        className="grid size-8 place-items-center text-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-45 @min-[640px]/composer:hidden"
        onClick={(event) => {
          event.preventDefault()
          const popover = popoverRef.current
          if (!popover) return
          if (popover.matches(':popover-open')) {
            popover.hidePopover()
            return
          }
          popover.showPopover()
          const anchor = event.currentTarget.getBoundingClientRect()
          const panel = popover.getBoundingClientRect()
          const top = anchor.top - panel.height - 8
          popover.style.left = `${Math.max(8, Math.min(anchor.right - panel.width, window.innerWidth - panel.width - 8))}px`
          popover.style.top = `${Math.max(8, Math.min(top >= 8 ? top : anchor.bottom + 8, window.innerHeight - panel.height - 8))}px`
          popover.querySelector<HTMLElement>('button, select')?.focus({ preventScroll: true })
        }}
      >
        <Icon icon="settings" size={20} aria-hidden="true" />
      </button>
      <div
        ref={popoverRef}
        id={popoverId}
        popover="auto"
        role="group"
        aria-label="Task options"
        className="fixed m-0 w-52 max-w-[calc(100vw-16px)] border border-line bg-raised p-3 text-fg shadow-[0_8px_32px_rgba(0,0,0,0.4)]"
        onToggle={(event) => setOpen(event.newState === 'open')}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          event.stopPropagation()
          popoverRef.current?.hidePopover()
          triggerRef.current?.focus()
        }}
      >
        <p className="mb-2 px-2 text-[11px] font-medium text-dim">Task options</p>
        <div className="flex flex-col items-start gap-2">{children}</div>
      </div>
    </div>
  )
}
