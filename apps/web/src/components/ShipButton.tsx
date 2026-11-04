import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { Task } from '@anvil/protocol/types'
import { useStore } from '../state/store'
import { btn, cn } from '../ui'
import { Icon } from '../icons'
import { ShipMessageModal } from './ShipMessageModal'

type MenuAction = 'ship-alternate' | 'ship-with-message' | 'open-pr'

export function ShipButton({ task, disabled, disabledReason, onOpenPullRequest }: {
  task: Task
  disabled: boolean
  disabledReason?: string
  onOpenPullRequest?: () => void
}): JSX.Element {
  const shipTask = useStore((s) => s.shipTask)
  const shipPushes = useStore((s) => s.projects.find((project) => project.id === task.projectId)?.shipPushes ?? false)
  const rootRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const firstItemRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<'ship' | 'push' | null>(null)
  const [error, setError] = useState('')
  const [messageModal, setMessageModal] = useState<{ push: boolean } | null>(null)

  useEffect(() => {
    if (!open) return
    firstItemRef.current?.focus()
    const close = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  const ship = async (push: boolean): Promise<void> => {
    setBusy('ship')
    setError('')
    try {
      await shipTask(task.id, { push })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(null)
    }
  }

  const pushShipped = async (): Promise<void> => {
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

  const select = (action: MenuAction): void => {
    setOpen(false)
    toggleRef.current?.focus()
    if (action === 'ship-alternate') void ship(!shipPushes)
    else if (action === 'ship-with-message') setMessageModal({ push: shipPushes })
    else onOpenPullRequest?.()
  }

  const errorNote = error && <span role="alert" className="max-w-80 truncate text-danger" title={error}>{error}</span>

  if (task.deliveryStatus === 'approved') {
    const shippedCommit = task.shippedCommit ?? task.headCommit
    const pushed = Boolean(shippedCommit && task.pushedCommit === shippedCommit)
    return <div className="flex min-w-0 items-center gap-2">
      {errorNote}
      {pushed
        ? <span className="flex items-center gap-1 py-1 text-xs text-ok">
          <Icon icon="check" size={14} aria-hidden="true" />
          Shipped &amp; pushed
        </span>
        : <button className={cn(btn.primary, 'bg-ok')} disabled={disabled || busy !== null} title={disabledReason}
          onClick={() => void pushShipped()}>
          {busy === 'push' ? 'Pushing…' : 'Push'}
        </button>}
    </div>
  }

  const label = shipPushes ? 'Ship & push' : 'Ship'
  const alternateLabel = shipPushes ? 'Ship without pushing' : 'Ship & push'
  const itemClass = 'block w-full px-3 py-2 text-left font-medium whitespace-nowrap text-fg hover:bg-hover focus:bg-hover focus:outline-none'

  return <div className="flex min-w-0 items-center gap-2">
    {errorNote}
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
      <button
        className={cn(btn.primary, 'inline-flex items-center gap-1.5 bg-ok')}
        disabled={disabled || busy !== null}
        title={disabledReason ?? (shipPushes
          ? 'Commit these changes with an agent-written message and push them'
          : 'Commit these changes with an agent-written message')}
        onClick={() => void ship(shipPushes)}
      >
        <Icon icon={busy === 'ship' ? 'loader' : 'arrow-big-up'} size={14} aria-hidden="true" className={busy === 'ship' ? 'animate-spin' : undefined} />
        {busy === 'ship' ? 'Shipping…' : label}
      </button>
      <button
        ref={toggleRef}
        className={cn(btn.primary, 'border-l border-canvas/25 bg-ok px-2')}
        disabled={disabled || busy !== null}
        title={disabledReason ?? 'More ship actions'}
        aria-label="More ship actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            setOpen(true)
          }
        }}
      >
        <Icon icon="chevron-down" size={14} aria-hidden="true" />
      </button>
      {open && <div
        role="menu"
        aria-label="Ship actions"
        className="absolute right-0 top-full z-30 mt-1.5 w-max min-w-full border border-line-strong bg-overlay p-1 shadow-[0_0_0_1px_var(--color-void)]"
      >
        <button ref={firstItemRef} role="menuitem" className={itemClass} onClick={() => select('ship-alternate')}>{alternateLabel}</button>
        <button role="menuitem" className={itemClass} onClick={() => select('ship-with-message')}>Ship with message…</button>
        {onOpenPullRequest && <button role="menuitem" className={itemClass} onClick={() => select('open-pr')}>Open pull request…</button>}
      </div>}
    </div>
    {messageModal && <ShipMessageModal task={task} push={messageModal.push} onClose={() => setMessageModal(null)} />}
  </div>
}
