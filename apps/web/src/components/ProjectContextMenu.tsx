import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Project } from '@anvil/protocol/types'
import { Icon } from '../icons'
import { useStore } from '../state/store'
import { DeleteConfirmationDialog } from './DeleteConfirmationDialog'

export interface ProjectMenuState {
  project: Project
  x: number
  y: number
}

export function ProjectContextMenu({ menu, onClose }: { menu: ProjectMenuState; onClose: () => void }): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null)
  const previousFocus = useRef(document.activeElement)
  const [confirming, setConfirming] = useState(false)

  const close = (): void => {
    onClose()
    const element = previousFocus.current
    if (element instanceof HTMLElement && element.isConnected) element.focus()
  }

  useLayoutEffect(() => {
    const element = menuRef.current
    if (!element || confirming) return
    const bounds = element.getBoundingClientRect()
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8))}px`
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8))}px`
    element.querySelector('button')?.focus()
  }, [menu, confirming])

  useEffect(() => {
    if (confirming) return
    const onPointerDown = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault()
        close()
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', onClose)
    }
  })

  if (confirming) return <DeleteConfirmationDialog title="Delete project?" name={menu.project.name}
    description={'Remove "{name}" and its tasks from Anvil? This cannot be undone.'}
    fileNotice="The project checkout on disk will not be deleted." confirmLabel="Delete project"
    onConfirm={() => useStore.getState().removeProject(menu.project.id)}
    onClose={close} />

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={`Project actions: ${menu.project.name}`}
      className="fixed z-[110] min-w-36 p-1 bg-overlay border border-line-strong shadow-[0_0_0_1px_var(--color-void)]"
      style={{ left: menu.x, top: menu.y }}
    >
      <button
        type="button"
        role="menuitem"
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-danger hover:bg-hover focus:bg-hover focus:outline-none"
        onClick={() => setConfirming(true)}
      >
        <Icon icon="trash" size={16} className="shrink-0" aria-hidden="true" />
        Remove project
      </button>
    </div>
  )
}
