import type { JSX, MouseEvent } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { HugeiconsIcon } from '@hugeicons/react'
import { Alert02Icon } from '@hugeicons/core-free-icons'
import { useStore } from '../state/store'
import { btn, cn, modal } from '../ui'

export function openTaskContextMenu(event: MouseEvent<HTMLElement>, taskId: string): void {
  event.preventDefault()
  event.stopPropagation()
  event.currentTarget.focus()
  const bounds = event.currentTarget.getBoundingClientRect()
  useStore.getState().setTaskMenu({
    taskId,
    x: event.clientX || bounds.left,
    y: event.clientY || bounds.bottom
  })
}

export function TaskContextMenu(): JSX.Element | null {
  const menu = useStore((state) => state.taskMenu)
  const task = useStore((state) => state.tasks.find((item) => item.id === menu?.taskId))
  const setTaskMenu = useStore((state) => state.setTaskMenu)
  const deleteTask = useStore((state) => state.deleteTask)
  const previousFocus = useRef(document.activeElement)
  const menuRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    return () => {
      const element = previousFocus.current
      if (element instanceof HTMLElement && element.isConnected) element.focus()
    }
  }, [])

  useLayoutEffect(() => {
    const element = menuRef.current
    if (!element || !menu || confirming) return
    const bounds = element.getBoundingClientRect()
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - bounds.width - 8))}px`
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - bounds.height - 8))}px`
    element.querySelector('button')?.focus()
  }, [menu, confirming])

  useEffect(() => {
    if (confirming) {
      dialogRef.current?.showModal()
      return
    }
    const onPointerDown = (event: PointerEvent): void => {
      if (!menuRef.current?.contains(event.target as Node)) setTaskMenu(null)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault()
        setTaskMenu(null)
      }
    }
    const close = (): void => setTaskMenu(null)
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', close)
    }
  }, [confirming, setTaskMenu])

  const confirmDelete = async (): Promise<void> => {
    if (!task || deleting) return
    setDeleting(true)
    setError(null)
    try {
      await deleteTask(task.id)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
      setDeleting(false)
    }
  }

  if (!menu || !task) return null

  if (confirming) {
    return (
      <dialog
        ref={dialogRef}
        aria-labelledby="delete-task-title"
        aria-describedby="delete-task-description delete-task-warning"
        className={cn(modal.panel, modal.width.narrow, 'm-auto text-fg backdrop:bg-black/55')}
        onCancel={(event) => {
          event.preventDefault()
          if (!deleting) setTaskMenu(null)
        }}
      >
        <h2 id="delete-task-title" className={modal.title}>Delete task?</h2>
        <p id="delete-task-description" className={cn(modal.copy, 'break-words')}>
          Permanently delete &quot;{task.title}&quot;, its output and review comments
          from Anvil? This cannot be undone.
        </p>
        {task.status === 'running' && (
          <p className={modal.copy}>The running agent will be stopped.</p>
        )}
        <p className={modal.copy}>Project files and Git branches will not be deleted.</p>
        <p id="delete-task-warning" className="mb-3.5 flex items-start gap-2 text-xs text-danger">
          <HugeiconsIcon icon={Alert02Icon} size={16} className="shrink-0" aria-hidden="true" />
          <span>This permanently removes the task and its related records from database storage.</span>
        </p>
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
        <div className={cn(modal.actions, 'justify-end')}>
          <button autoFocus className={btn.ghost} disabled={deleting} onClick={() => setTaskMenu(null)}>
            Cancel
          </button>
          <button
            className={cn(btn.danger, 'disabled:opacity-45 disabled:cursor-not-allowed')}
            disabled={deleting}
            onClick={() => void confirmDelete()}
          >
            {deleting ? 'Deleting…' : 'Delete task'}
          </button>
        </div>
      </dialog>
    )
  }

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Task actions"
      className="fixed z-[110] min-w-36 p-1 bg-raised border border-line rounded-md shadow-lg"
      style={{ left: menu.x, top: menu.y }}
    >
      <button
        role="menuitem"
        className="w-full px-3 py-1.5 text-left text-danger rounded hover:bg-hover focus:bg-hover focus:outline-none"
        onClick={() => setConfirming(true)}
      >
        Delete
      </button>
    </div>
  )
}
