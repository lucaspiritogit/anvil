import type { JSX, ReactNode, RefObject } from 'react'
import { useLayoutEffect, useRef } from 'react'

// Shared top-layer placement, keyboard containment and trigger focus restoration.
export function PickerDialog({ anchorRef, label, onClose, children, wide = false }: {
  anchorRef: RefObject<HTMLButtonElement | null>
  label: string
  onClose: () => void
  wide?: boolean
  children: ReactNode
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useLayoutEffect(() => {
    const dialog = dialogRef.current
    const anchor = anchorRef.current
    if (!dialog || !anchor) return
    dialog.showModal()
    dialog.querySelector<HTMLInputElement>('input')?.focus()
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
      aria-label={label}
      className={`fixed m-0 h-[min(400px,calc(100dvh-16px))] max-h-none ${wide ? 'w-[min(640px,calc(100vw-16px))]' : 'w-[min(420px,calc(100vw-16px))]'} max-w-none overflow-hidden border border-line bg-raised p-0 text-fg shadow-[0_16px_64px_rgba(0,0,0,0.5)] backdrop:bg-black/20`}
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
        event.stopPropagation()
        if (event.target !== event.currentTarget) return
        const bounds = event.currentTarget.getBoundingClientRect()
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose()
      }}
    >
      {children}
    </dialog>
  )
}
