import type { JSX, ReactNode } from 'react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

export function ComposerOptionTooltip({ title, description, disabled = false, children }: {
  title: string
  description: string
  disabled?: boolean
  children: (tooltipId: string) => ReactNode
}): JSX.Element {
  const tooltipId = useId()
  const anchorRef = useRef<HTMLDivElement>(null)
  const tooltipRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hovered = useRef(false)
  const focused = useRef(false)
  const dismissed = useRef(false)
  const [open, setOpen] = useState(false)

  const cancelTimer = (): void => {
    if (timerRef.current === null) return
    clearTimeout(timerRef.current)
    timerRef.current = null
  }
  const close = (): void => {
    cancelTimer()
    setOpen(false)
  }
  const show = (delay: number): void => {
    cancelTimer()
    if (disabled || dismissed.current) return
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (dismissed.current) return
      setOpen(true)
    }, delay)
  }
  const hideAfterLeaving = (): void => {
    cancelTimer()
    if (hovered.current || focused.current) return
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setOpen(false)
    }, 120)
  }

  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
  }, [])

  useEffect(() => {
    if (!disabled) return
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
    setOpen(false)
  }, [disabled])

  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const tooltip = tooltipRef.current
    if (!open || !anchor || !tooltip) return
    tooltip.showPopover()

    const position = (): void => {
      const bounds = anchor.getBoundingClientRect()
      const measuredPanel = tooltip.getBoundingClientRect()
      const layoutWidth = Number.parseFloat(window.getComputedStyle(tooltip).width)
      const zoom = measuredPanel.width / layoutWidth || 1
      tooltip.style.maxWidth = `${Math.max(0, window.innerWidth - 16) / zoom}px`
      const panel = tooltip.getBoundingClientRect()
      const above = bounds.top - panel.height - 8
      const top = above >= 8 ? above : bounds.bottom + 8
      const left = Math.max(8, Math.min(bounds.left, window.innerWidth - panel.width - 8))
      const clampedTop = Math.max(8, Math.min(top, window.innerHeight - panel.height - 8))
      tooltip.style.left = `${left / zoom}px`
      tooltip.style.top = `${clampedTop / zoom}px`
    }
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (timerRef.current !== null) clearTimeout(timerRef.current)
      timerRef.current = null
      dismissed.current = true
      setOpen(false)
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(anchor)
    observer.observe(tooltip)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    window.addEventListener('keydown', dismiss, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
      window.removeEventListener('keydown', dismiss, true)
      tooltip.hidePopover()
    }
  }, [open])

  return (
    <div
      ref={anchorRef}
      className="flex min-w-0 items-center"
      onPointerEnter={(event) => {
        if (event.pointerType === 'touch') return
        hovered.current = true
        dismissed.current = false
        show(220)
      }}
      onPointerLeave={() => {
        hovered.current = false
        hideAfterLeaving()
      }}
      onFocus={(event) => {
        if (!event.target.matches(':focus-visible') || event.target.closest('.menu-select-panel')) return
        focused.current = true
        dismissed.current = false
        show(0)
      }}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return
        focused.current = false
        hideAfterLeaving()
      }}
      onPointerDownCapture={() => {
        dismissed.current = true
        close()
      }}
      onKeyDownCapture={(event) => {
        if (!['Enter', ' ', 'ArrowUp', 'ArrowDown', 'Escape'].includes(event.key)) return
        dismissed.current = true
        close()
      }}
    >
      {children(tooltipId)}
      <div
        ref={tooltipRef}
        id={tooltipId}
        role="tooltip"
        popover="manual"
        className="composer-option-tooltip fixed m-0 w-72 max-w-[calc(100vw-16px)] border border-line-strong bg-overlay px-3.5 py-3 text-left text-xs leading-relaxed text-fg shadow-[0_0_0_1px_var(--color-void)]"
      >
        <p className="mb-1 font-medium">{title}</p>
        <p className="text-dim">{description}</p>
      </div>
    </div>
  )
}
