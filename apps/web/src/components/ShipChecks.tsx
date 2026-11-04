import type { CSSProperties, JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Task } from '@anvil/protocol/types'
import { useStore } from '../state/store'
import { btn, cn } from '../ui'
import { Icon } from '../icons'

const FAILURE_TAIL = 6_000

export function checksAreCurrent(task: Task): boolean {
  return Boolean(task.checks && (!task.checks.headCommit || task.checks.headCommit === task.headCommit))
}

export function ShipChecks({ task }: { task: Task }): JSX.Element | null {
  const checkCommand = useStore((s) => s.projects.find((project) => project.id === task.projectId)?.checkCommand)
  const steerTask = useStore((s) => s.steerTask)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<CSSProperties>({})
  const [busy, setBusy] = useState<'run' | 'send' | null>(null)
  const [error, setError] = useState('')
  const checks = task.checks
  const current = checksAreCurrent(task)

  useEffect(() => {
    if (!open) return
    const place = (): void => {
      const rect = buttonRef.current?.getBoundingClientRect()
      if (!rect) return
      const width = Math.min(560, window.innerWidth - 32)
      const left = Math.max(16, Math.min(rect.right - width, window.innerWidth - 16 - width))
      setPosition({ position: 'fixed', top: rect.bottom + 6, left, width })
    }
    place()
    const close = (event: PointerEvent): void => {
      const target = event.target as Node
      if (!rootRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
        buttonRef.current?.focus()
      }
    }
    document.addEventListener('pointerdown', close)
    document.addEventListener('keydown', escape)
    window.addEventListener('resize', place)
    return () => {
      document.removeEventListener('pointerdown', close)
      document.removeEventListener('keydown', escape)
      window.removeEventListener('resize', place)
    }
  }, [open])

  if (!checkCommand && !checks) return null

  const run = async (): Promise<void> => {
    setBusy('run')
    setError('')
    try {
      await window.anvil.tasks.runChecks(task.id)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(null)
    }
  }

  const sendToAgent = async (): Promise<void> => {
    if (!checks) return
    setBusy('send')
    setError('')
    try {
      const output = checks.output.slice(-FAILURE_TAIL)
      await steerTask(task.id, [
        `The project checks failed. Fix the cause, then make sure \`${checks.command}\` passes.`,
        '',
        `Exit code: ${checks.exitCode ?? 'none'}`,
        '```',
        output.trim() || '(no output)',
        '```'
      ].join('\n'))
      setOpen(false)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(null)
    }
  }

  const running = checks?.status === 'running' || busy === 'run'
  const tone = running ? 'text-run' : !checks || !current ? 'text-dim' : checks.status === 'passed' ? 'text-ok' : 'text-danger'
  const label = running
    ? 'Running checks…'
    : !checks
      ? 'Run checks'
      : !current
        ? 'Checks out of date'
        : checks.status === 'passed' ? 'Checks passed' : 'Checks failed'
  const icon = running ? 'loader' : checks?.status === 'passed' && current ? 'check' : checks?.status === 'failed' && current ? 'x' : null

  return <div ref={rootRef} className="inline-flex shrink-0">
    <button
      ref={buttonRef}
      type="button"
      className={cn('inline-flex items-center gap-1.5 px-2 py-[7px] text-xs font-medium hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent', tone)}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={checks ? `${checks.command}${checks.finishedAt ? ` · finished ${new Date(checks.finishedAt).toLocaleTimeString()}` : ''}` : checkCommand}
      onClick={() => {
        if (!checks && !running) void run()
        else setOpen((value) => !value)
      }}
    >
      {icon && <Icon icon={icon} size={13} aria-hidden="true" className={running ? 'animate-spin' : undefined} />}
      {label}
    </button>
    {open && checks && createPortal(<div
      ref={popoverRef}
      role="dialog"
      aria-label="Check results"
      style={position}
      className="z-40 flex flex-col gap-2 border border-line-strong bg-overlay p-3 text-fg shadow-[0_0_0_1px_var(--color-void)]"
    >
      <div className="flex items-center justify-between gap-3">
        <code className="min-w-0 truncate font-mono text-[11px] text-dim" title={checks.command}>{checks.command}</code>
        <span className={cn('shrink-0 font-mono text-[11px]', tone)}>
          {running ? 'running' : checks.exitCode === null || checks.exitCode === undefined ? checks.status : `exit ${checks.exitCode}`}
        </span>
      </div>
      <pre aria-label="Check output" className="max-h-72 overflow-auto whitespace-pre-wrap break-words border border-line bg-canvas p-2 font-mono text-[11px] leading-relaxed text-soft">
        {checks.output.trim() || (running ? 'Waiting for output…' : '(no output)')}
      </pre>
      {error && <p role="alert" className="text-xs text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        {checks.status === 'failed' && current && <button className={btn.ghost} disabled={busy !== null || task.status === 'running'} onClick={() => void sendToAgent()}>
          {busy === 'send' ? 'Sending…' : 'Send failure to agent'}
        </button>}
        <button className={btn.ghost} disabled={running || busy !== null || !checkCommand} onClick={() => void run()}>
          {running ? 'Running…' : 'Run again'}
        </button>
      </div>
    </div>, document.body)}
    {error && !open && <span role="alert" className="ml-2 max-w-64 truncate self-center text-xs text-danger" title={error}>{error}</span>}
  </div>
}
