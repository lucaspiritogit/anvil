import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { Task } from '@shared/types'
import { taskStyle } from '@shared/task-style'
import { btn, cn } from '../ui'
import { Icon } from '../icons'
import { CommitQuickTaskModal } from './CommitQuickTaskModal'

export function QuickCommitActions({ task }: { task: Task }): JSX.Element | null {
  const rootRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const menuItemRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [modal, setModal] = useState<{ push: boolean } | null>(null)
  const [busy, setBusy] = useState<'push' | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    menuItemRef.current?.focus()
    const close = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  const quickLocal = taskStyle(task) === 'quick' && task.checkoutMode === 'local'
  if (!quickLocal || !['reviewable', 'approved'].includes(task.deliveryStatus)) return null
  const pushed = Boolean(task.headCommit && task.pushedCommit === task.headCommit)

  const push = async (): Promise<void> => {
    setBusy('push')
    setError('')
    try {
      const preview = await window.anvil.tasks.pushPreview(task.id)
      await window.anvil.tasks.push({ taskId: task.id, preview })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(null)
    }
  }

  return <div className="flex min-w-0 items-center gap-2">
    {error && <span role="alert" className="max-w-80 truncate text-danger" title={error}>{error}</span>}
    {task.deliveryStatus === 'approved' ? pushed ?
    <span className="flex items-center gap-1 py-1 text-xs text-ok">
      <Icon icon="check" size={14} aria-hidden="true" />
      Pushed
    </span> :
    <button className={cn(btn.primary, 'bg-ok')} disabled={busy !== null} onClick={() => void push()}>
      {busy === 'push' ? 'Pushing…' : 'Push'}
    </button> :
    <>
      <div
        ref={rootRef}
        className="relative inline-flex shrink-0"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false)
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault()
            setOpen(false)
            toggleRef.current?.focus()
          }
        }}
      >
        <button className={cn(btn.primary, 'bg-ok')} onClick={() => setModal({ push: false })}>
          Commit
        </button>
        <button
          ref={toggleRef}
          className={cn(btn.primary, 'border-l border-canvas/25 bg-ok px-2')}
          aria-label="More commit actions"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon icon="chevron-down" size={14} aria-hidden="true" />
        </button>
        {open && <div role="menu" aria-label="Commit actions" className="absolute right-0 top-full z-30 mt-1.5 w-max min-w-full border border-line bg-raised p-1 shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
          <button ref={menuItemRef} role="menuitem" className="block w-full px-3 py-2 text-left font-medium whitespace-nowrap text-fg hover:bg-hover focus:bg-hover focus:outline-none" onClick={() => { setOpen(false); setModal({ push: true }) }}>
            Commit &amp; Push
          </button>
        </div>}
      </div>
      {modal && <CommitQuickTaskModal task={task} push={modal.push} onClose={() => setModal(null)} />}
    </>}
  </div>
}
