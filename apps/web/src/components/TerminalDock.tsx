import type { JSX, PointerEvent as ReactPointerEvent } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Task } from '@anvil/protocol/types'
import { Icon } from '../icons'
import { cn } from '../ui'
import { GhosttyTerminal } from './GhosttyTerminal'
import { TerminalCommandInput } from './TerminalCommandInput'

type DockTab = { id: string; taskId?: string; label: string }

const HEIGHT_KEY = 'anvil:terminal-dock-height'
const DEFAULT_RATIO = 0.4
const MIN_HEIGHT = 120
const MAX_RATIO = 0.7

function storedRatio(): number {
  try {
    const value = Number(window.localStorage.getItem(HEIGHT_KEY))
    return value > 0 && value <= MAX_RATIO ? value : DEFAULT_RATIO
  } catch {
    return DEFAULT_RATIO
  }
}

function storeRatio(value: number): void {
  try { window.localStorage.setItem(HEIGHT_KEY, String(value)) } catch { /* Storage is optional. */ }
}

function TerminalSession({ projectId, taskId, active, visible, onExit }: {
  projectId: string
  taskId?: string
  active: boolean
  visible: boolean
  onExit: (exitCode: number) => void
}): JSX.Element {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [exited, setExited] = useState(false)

  useEffect(() => {
    let cancelled = false
    let id: string | undefined
    void window.anvil.terminals.create({ projectId, ...(taskId ? { taskId } : {}), cols: 120, rows: 24 }).then((session) => {
      id = session.sessionId
      if (cancelled) void window.anvil.terminals.dispose(id).catch(() => {})
      else setSessionId(id)
    }).catch(() => { if (!cancelled) setError(true) })
    return () => {
      cancelled = true
      if (id) void window.anvil.terminals.dispose(id).catch(() => {})
    }
  }, [projectId, taskId])

  return (
    <div className={cn('min-h-0 flex-1 flex-col', active ? 'flex' : 'hidden')}>
      {error ? <p role="alert" className="p-3 text-xs text-danger">Could not open the project terminal. Close the session and try again.</p>
        : sessionId ? <>
          <GhosttyTerminal key={sessionId} sessionId={sessionId} visible={visible && active} className="min-h-0 flex-1"
            onExit={(code) => { setExited(true); onExit(code) }} />
          <div className="hidden shrink-0 [@media(pointer:coarse)]:block">
            <TerminalCommandInput key={sessionId} sessionId={sessionId} disabled={exited} />
          </div>
        </> : <p role="status" className="p-3 font-mono text-xs text-dim">Starting terminal…</p>}
    </div>
  )
}

export function TerminalDock({ projectId, projectName, task, open, onOpen, onCollapse, onCloseAll }: {
  projectId: string
  projectName: string
  task?: Task
  open: boolean
  onOpen(): void
  onCollapse(): void
  onCloseAll(): void
}): JSX.Element {
  const dockRef = useRef<HTMLElement>(null)
  const nextId = useRef(1)
  const [tabs, setTabs] = useState<DockTab[]>(() => [{ id: 'project', label: projectName }])
  const [activeId, setActiveId] = useState('project')
  const [exits, setExits] = useState<Record<string, number>>({})
  const [ratio, setRatio] = useState(storedRatio)
  const [available, setAvailable] = useState(0)
  const [dragging, setDragging] = useState(false)
  const taskTabId = task ? `task:${task.id}` : null

  useEffect(() => {
    if (!task || !taskTabId || !open) return
    setTabs((current) => current.some((tab) => tab.id === taskTabId) ? current
      : [...current, { id: taskTabId, taskId: task.id, label: task.branchName ?? task.title }])
    setActiveId(taskTabId)
  }, [task?.id, taskTabId, open])

  useLayoutEffect(() => {
    const parent = dockRef.current?.parentElement
    if (!parent) return
    const measure = (): void => setAvailable(parent.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(parent)
    return () => observer.disconnect()
  }, [])

  const height = available ? Math.round(Math.min(available * MAX_RATIO, Math.max(MIN_HEIGHT, available * ratio))) : undefined

  const startResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const parent = dockRef.current?.parentElement
    if (!parent) return
    event.preventDefault()
    const bounds = parent.getBoundingClientRect()
    setDragging(true)
    const move = (moveEvent: PointerEvent): void => {
      const next = Math.min(MAX_RATIO, Math.max(MIN_HEIGHT / bounds.height, (bounds.bottom - moveEvent.clientY) / bounds.height))
      setRatio(next)
    }
    const up = (upEvent: PointerEvent): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDragging(false)
      storeRatio(Math.min(MAX_RATIO, Math.max(MIN_HEIGHT / bounds.height, (bounds.bottom - upEvent.clientY) / bounds.height)))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const addSession = (): void => {
    const scope = tabs.find((tab) => tab.id === activeId)
    const id = `extra:${nextId.current++}`
    setTabs((current) => [...current, { id, taskId: scope?.taskId, label: scope?.label ?? projectName }])
    setActiveId(id)
  }

  const closeSession = (id: string): void => {
    const remaining = tabs.filter((tab) => tab.id !== id)
    if (!remaining.length) {
      onCloseAll()
      return
    }
    setTabs(remaining)
    if (activeId === id) setActiveId(remaining.at(-1)!.id)
  }

  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0]
  const activeExit = exits[active.id]

  return (
    <>
      {!open && <button type="button" aria-label="Open project terminal" onClick={onOpen}
        className="flex h-7 w-full shrink-0 items-center gap-2 border-t border-line bg-canvas px-4 font-mono text-[11px] text-dim hover:bg-hover hover:text-fg focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-accent">
        <span aria-hidden="true" className="text-ember-400">▸</span>
        <span>terminal</span>
        <span aria-hidden="true" className="text-faint">·</span>
        <span>{tabs.length} {tabs.length === 1 ? 'session' : 'sessions'}</span>
        {activeExit !== undefined && <span className={activeExit === 0 ? 'text-faint' : 'text-danger-text'}>· {activeExit === 0 ? 'exited' : `✕ exit ${activeExit}`}</span>}
        <span className="ml-auto text-faint">⌃`</span>
      </button>}
      <section ref={dockRef} aria-label="Project terminal" hidden={!open}
        style={{ height }}
        className={cn('relative z-10 flex min-h-0 shrink-0 flex-col border-t border-line-strong bg-void',
          'max-[700px]:absolute max-[700px]:inset-0 max-[700px]:!h-auto max-[700px]:border-t-0 max-[700px]:shadow-[0_0_0_1px_var(--color-line-strong)]',
          dragging && 'select-none')}>
        <div role="separator" aria-orientation="horizontal" aria-label="Resize terminal" title="Drag to resize · double-click to reset"
          className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize hover:bg-accent/30 max-[700px]:hidden"
          onPointerDown={startResize}
          onDoubleClick={() => { setRatio(DEFAULT_RATIO); storeRatio(DEFAULT_RATIO) }} />
        <div className="flex h-8 shrink-0 items-stretch border-b border-line bg-canvas font-mono text-[11px]">
          <div role="tablist" aria-label="Terminal sessions" className="flex min-w-0 items-stretch overflow-x-auto">
            {tabs.map((tab) => {
              const selected = tab.id === active.id
              const exit = exits[tab.id]
              return <div key={tab.id} className={cn('group flex shrink-0 items-center border-r border-line', selected ? 'bg-void text-fg shadow-[inset_0_2px_0_var(--color-accent)]' : 'text-dim hover:bg-hover hover:text-fg')}>
                <button type="button" role="tab" aria-selected={selected} onClick={() => setActiveId(tab.id)}
                  title={tab.taskId ? 'Opens in the task worktree' : 'Opens at the project root'}
                  className="flex h-full max-w-56 items-center gap-1.5 pl-3 pr-1.5 focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-accent">
                  <span aria-hidden="true" className={tab.taskId ? 'text-ember-400' : 'text-faint'}>{tab.taskId ? '⎇' : '~'}</span>
                  <span className="truncate">{tab.label}</span>
                  {tab.taskId && <span className="text-faint">worktree</span>}
                  {exit !== undefined && <span className={exit === 0 ? 'text-faint' : 'text-danger-text'}>{exit === 0 ? '·' : '✕'}</span>}
                </button>
                <button type="button" aria-label={`Close terminal session: ${tab.label}`} onClick={() => closeSession(tab.id)}
                  className={cn('mr-1 grid size-5 place-items-center text-faint hover:bg-overlay hover:text-fg focus-visible:outline focus-visible:outline-accent', !selected && 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100')}>
                  <Icon icon="x" size={11} aria-hidden="true" />
                </button>
              </div>
            })}
          </div>
          <button type="button" aria-label="New terminal session" title="New session in the current folder" onClick={addSession}
            className="grid w-8 shrink-0 place-items-center text-dim hover:bg-hover hover:text-fg focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-accent">+</button>
          <span className="ml-auto flex shrink-0 items-center gap-2 pr-1 text-faint">
            <span className="max-[700px]:hidden">⌃`</span>
            <button type="button" aria-label="Close project terminal" title="Collapse the terminal (sessions keep running)" onClick={onCollapse}
              className="grid size-6 place-items-center text-dim hover:bg-hover hover:text-fg focus-visible:outline focus-visible:outline-accent">
              <Icon icon="chevron-down" size={14} aria-hidden="true" />
            </button>
          </span>
        </div>
        <div className="flex min-h-0 flex-1 flex-col px-2 py-1">
          {tabs.map((tab) => <TerminalSession key={tab.id} projectId={projectId} taskId={tab.taskId}
            active={tab.id === active.id} visible={open}
            onExit={(code) => setExits((current) => ({ ...current, [tab.id]: code }))} />)}
        </div>
      </section>
    </>
  )
}
