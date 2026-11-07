import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { Task } from '@anvil/protocol/types'
import { useStore } from '../state/store'
import { btn, cn } from '../ui'
import { Icon } from '../icons'
import { ShipMessageModal } from './ShipMessageModal'
import { checksAreCurrent } from './ShipChecks'

type MenuAction = 'ship-with-message' | 'open-pr'

const HOLD_MS = 900
const TRACK = 12
const WAVES = "_.~'~."
const CELEBRATION = [
  '     .      ',
  '    .*.     ',
  '   .*+*.    ',
  '  * .+. *   ',
  ' +  \\|/  +  ',
  '*  --*--  * ',
  ' +  /|\\  +  ',
  '  *  |  *   ',
  '   . | .    ',
  '     |      '
]

function useFrame(active: boolean, interval: number): number {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!active) return
    setFrame(0)
    const timer = window.setInterval(() => setFrame((value) => value + 1), interval)
    return () => window.clearInterval(timer)
  }, [active, interval])
  return frame
}

function sailingFrame(frame: number): string {
  const boat = frame % (TRACK + 2) - 2
  return Array.from({ length: TRACK }, (_, index) => {
    if (index === boat) return '='
    if (index === boat + 1) return '>'
    if (index < boat) return '-'
    return WAVES[(index + frame) % WAVES.length]
  }).join('')
}

function ShippingAscii(): JSX.Element {
  const frame = useFrame(true, 90)
  return <span aria-hidden="true" className="font-mono text-[11px] leading-none whitespace-pre">[{sailingFrame(frame)}]</span>
}

function ShippedAscii({ onDone }: { onDone: () => void }): JSX.Element {
  const frame = useFrame(true, 110)
  const finished = frame >= CELEBRATION.length + 6
  useEffect(() => {
    if (finished) onDone()
  }, [finished, onDone])
  const art = (frame < CELEBRATION.length ? CELEBRATION[frame] : ' ~ landed ~ ').padEnd(12)
  return <span className="flex items-center gap-2 py-1 text-xs text-ok" role="status">
    <span aria-hidden="true" className="font-mono text-[11px] leading-none whitespace-pre">{art}</span>
    Shipped &amp; pushed
  </span>
}

export function ShipButton({ task, disabled, disabledReason, onOpenPullRequest }: {
  task: Task
  disabled: boolean
  disabledReason?: string
  onOpenPullRequest?: () => void
}): JSX.Element {
  const shipTask = useStore((s) => s.shipTask)
  const undoShip = useStore((s) => s.undoShip)
  const shippingInStore = useStore((s) => Boolean(s.shippingTaskIds[task.id]))
  const rootRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const firstItemRef = useRef<HTMLButtonElement>(null)
  const holdFrame = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const [localBusy, setBusy] = useState<'ship' | 'push' | 'undo' | null>(null)
  const busy = localBusy ?? (shippingInStore ? 'ship' : null)
  const [error, setError] = useState('')
  const [messageModal, setMessageModal] = useState(false)
  const [targetBranch, setTargetBranch] = useState<string | null>(null)
  const [hold, setHold] = useState(0)
  const [celebrate, setCelebrate] = useState(false)
  const ready = task.deliveryStatus === 'reviewable'

  useEffect(() => {
    if (!ready || !task.projectId) return
    const projectId = task.projectId
    let current = true
    const refresh = (): void => {
      window.anvil.projects.branches(projectId).then(
        (branches) => { if (current) setTargetBranch(branches.currentBranch) },
        () => { if (current) setTargetBranch(null) }
      )
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      current = false
      window.removeEventListener('focus', refresh)
    }
  }, [ready, task.projectId])

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

  useEffect(() => () => {
    if (holdFrame.current !== null) cancelAnimationFrame(holdFrame.current)
  }, [])

  const ship = async (): Promise<void> => {
    setBusy('ship')
    setError('')
    try {
      const shipped = await shipTask(task.id, { push: true })
      if (shipped.deliveryStatus === 'approved') setCelebrate(true)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(null)
    }
  }

  const cancelHold = (): void => {
    if (holdFrame.current !== null) cancelAnimationFrame(holdFrame.current)
    holdFrame.current = null
    setHold(0)
  }

  const startHold = (): void => {
    if (disabled || busy !== null || holdFrame.current !== null) return
    const started = performance.now()
    const step = (now: number): void => {
      const progress = Math.min(1, (now - started) / HOLD_MS)
      setHold(progress)
      if (progress < 1) {
        holdFrame.current = requestAnimationFrame(step)
        return
      }
      holdFrame.current = null
      setHold(0)
      void ship()
    }
    holdFrame.current = requestAnimationFrame(step)
  }

  const holdKey = (event: ReactKeyboardEvent, down: boolean): void => {
    if (event.key !== ' ' && event.key !== 'Enter') return
    event.preventDefault()
    if (!down) cancelHold()
    else if (!event.repeat) startHold()
  }

  const pushShipped = async (): Promise<void> => {
    setBusy('push')
    setError('')
    try {
      const preview = await window.anvil.tasks.pushPreview(task.id)
      await window.anvil.tasks.push({ taskId: task.id, preview })
      setCelebrate(true)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(null)
    }
  }

  const undo = async (): Promise<void> => {
    setBusy('undo')
    setError('')
    try {
      await undoShip(task.id)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(null)
    }
  }

  const select = (action: MenuAction): void => {
    setOpen(false)
    toggleRef.current?.focus()
    if (action === 'ship-with-message') setMessageModal(true)
    else onOpenPullRequest?.()
  }

  const errorNote = error && <span role="alert" className="max-w-80 truncate text-danger" title={error}>{error}</span>

  if (task.deliveryStatus === 'approved') {
    const shippedCommit = task.shippedCommit ?? task.headCommit
    const pushed = Boolean(shippedCommit && task.pushedCommit === shippedCommit)
    return <div className="flex min-w-0 items-center gap-2">
      {errorNote}
      {pushed
        ? celebrate
          ? <ShippedAscii onDone={() => setCelebrate(false)} />
          : <span className="flex items-center gap-1 py-1 text-xs text-ok">
            <Icon icon="check" size={14} aria-hidden="true" />
            Shipped &amp; pushed
          </span>
        : <>
          {task.shippedCommit && busy !== 'push' && <button className={btn.ghost} disabled={busy !== null}
            title="Move the branch back to before this ship and make the task ready to ship again"
            onClick={() => void undo()}>
            {busy === 'undo' ? 'Undoing…' : 'Undo ship'}
          </button>}
          <button className={cn(btn.primary, 'inline-flex items-center gap-1.5 bg-ok')} disabled={disabled || busy !== null} title={disabledReason ?? 'The commit landed but was not pushed. Push it to origin'}
            onClick={() => void pushShipped()}>
            {busy === 'push' ? <><ShippingAscii />Pushing…</> : 'Push'}
          </button>
        </>}
    </div>
  }

  const destination = targetBranch ? ` to ${targetBranch}` : ''
  const label = `Ship${destination}`
  const offBase = Boolean(targetBranch && task.baseBranch && targetBranch !== task.baseBranch)
  const checksFailed = task.checks?.status === 'failed' && checksAreCurrent(task)
  const checksRunning = task.checks?.status === 'running'
  const itemClass = 'block w-full px-3 py-2 text-left font-medium whitespace-nowrap text-fg hover:bg-hover focus:bg-hover focus:outline-none'
  const shipping = busy === 'ship'

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
        className={cn(btn.primary, 'relative inline-flex touch-none items-center gap-1.5 overflow-hidden select-none', checksFailed ? 'bg-warn' : 'bg-ok')}
        disabled={disabled || busy !== null}
        aria-label={shipping ? 'Shipping…' : label}
        title={disabledReason ?? [
          'Hold to commit these changes with an agent-written message and push them',
          checksFailed ? 'Checks failed for these changes. Shipping now ships them anyway' : '',
          checksRunning ? 'Checks are still running' : '',
          offBase ? `This task started from ${task.baseBranch}, but the project has ${targetBranch} checked out.` : ''
        ].filter(Boolean).join('. ')}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.currentTarget.setPointerCapture(event.pointerId)
          startHold()
        }}
        onPointerUp={cancelHold}
        onPointerCancel={cancelHold}
        onLostPointerCapture={cancelHold}
        onKeyDown={(event) => holdKey(event, true)}
        onKeyUp={(event) => holdKey(event, false)}
        onBlur={cancelHold}
        onContextMenu={(event) => event.preventDefault()}
      >
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 bg-canvas/25" style={{ width: `${hold * 100}%` }} />
        <span className="relative inline-flex items-center gap-1.5">
          {shipping
            ? <><ShippingAscii />Shipping…</>
            : <>
              <Icon icon="arrow-big-up" size={14} aria-hidden="true" />
              {hold > 0 ? 'Keep holding…' : label}
              {offBase && <Icon icon="git-branch" size={13} aria-label={`Started from ${task.baseBranch}`} className="text-canvas/80" />}
            </>}
        </span>
      </button>
      <button
        ref={toggleRef}
        className={cn(btn.primary, 'border-l border-canvas/25 px-2', checksFailed ? 'bg-warn' : 'bg-ok')}
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
        <button ref={firstItemRef} role="menuitem" className={itemClass} onClick={() => select('ship-with-message')}>Ship with message…</button>
        {onOpenPullRequest && <button role="menuitem" className={itemClass} onClick={() => select('open-pr')}>Open pull request…</button>}
      </div>}
    </div>
    {messageModal && <ShipMessageModal task={task} push onClose={() => setMessageModal(false)} />}
  </div>
}
