import type { JSX } from 'react'
import { lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Task, TaskEvent, TaskEventCategory } from '@shared/types'
import { TASK_EVENT_CATEGORIES } from '@shared/types'
import type { taskIssuePresentation } from '@shared/task-issue-presentation'
import { BROWSER_VIEWPORTS, type BrowserViewport } from '@shared/browser-observation'
import { taskStyle } from '@shared/task-style'
import { useStore } from '../state/store'
import { btn, cn } from '../ui'
import { Icon } from '../icons'
import { TaskActivity } from './TaskActivity'

const PLACEHOLDER = 'py-8 text-center text-dim'
const BROWSER_HEADER_HEIGHT = 32
const BROWSER_MAX_WIDTH_RATIO = 0.48

type Direction = 'initial' | 'latest' | 'older'
type Anchor = { id: string; offset: number }

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

const scrollBehavior = (): ScrollBehavior =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'

function QuickCommitActions({ task }: { task: Task }): JSX.Element | null {
  const rootRef = useRef<HTMLDivElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const menuItemRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<'commit' | 'push' | null>(null)
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

  const commit = async (push: boolean): Promise<void> => {
    setOpen(false)
    setBusy(push ? 'push' : 'commit')
    setError('')
    try {
      await window.anvil.tasks.commitQuick({ taskId: task.id, push })
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setBusy(null)
    }
  }

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

  return <div className="ml-auto flex min-w-0 items-center gap-2">
    {error && <span role="alert" className="max-w-80 truncate text-danger" title={error}>{error}</span>}
    {task.deliveryStatus === 'approved' ? <button className={cn(btn.primary, 'bg-ok py-1 text-xs')} disabled={busy !== null} onClick={() => void push()}>
      {busy === 'push' ? 'Pushing…' : 'Push'}
    </button> :
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
      <button className={cn(btn.primary, 'bg-ok py-1 text-xs')} disabled={busy !== null} onClick={() => void commit(false)}>
        {busy === 'commit' ? 'Committing…' : 'Commit'}
      </button>
      <button
        ref={toggleRef}
        className={cn(btn.primary, 'border-l border-canvas/25 bg-ok px-2 py-1')}
        disabled={busy !== null}
        aria-label="More commit actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon icon="chevron-down" size={14} aria-hidden="true" />
      </button>
      {open && <div role="menu" aria-label="Commit actions" className="absolute right-0 top-full z-30 mt-1.5 w-max min-w-full border border-line bg-raised p-1 shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
        <button ref={menuItemRef} role="menuitem" className="block w-full px-3 py-2 text-left font-medium whitespace-nowrap text-fg hover:bg-hover focus:bg-hover focus:outline-none" onClick={() => void commit(true)}>
          Commit &amp; Push
        </button>
      </div>}
    </div>}
  </div>
}

const MergeConflictOutput = lazy(async () => ({
  default: (await import('./TaskMergeConflictOutput')).TaskMergeConflictOutput
}))

export function TaskOutput({ task, visible, presentation }: {
  task: Task
  visible: boolean
  presentation: ReturnType<typeof taskIssuePresentation>
}): JSX.Element {
  const events = useStore((state) => task.deliveryStatus === 'merge_conflict' ? undefined : state.eventsByTask[task.id])
  if (task.deliveryStatus === 'merge_conflict' && task.mergeConflict) {
    return <Suspense fallback={<section id="task-panel-output" aria-label="Output" className={cn('grid flex-1 place-content-center text-sm text-dim', !visible && 'hidden')}>Loading conflict resolver…</section>}>
      <MergeConflictOutput task={task} conflict={task.mergeConflict} visible={visible} />
    </Suspense>
  }
  return <TaskOutputHistory task={task} visible={visible} presentation={presentation} events={events} />
}

type Row =
  | { kind: 'event'; event: TaskEvent }
  | { kind: 'tool'; use: TaskEvent; result: TaskEvent }

/* A tool call and the result snapshot that follows it form one row: the result
 * nests under its call instead of doubling the stream's row count. */
function buildRows(events: TaskEvent[] | undefined): Row[] {
  if (!events) return []
  const rows: Row[] = []
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    const next = events[index + 1]
    if (event.category === 'tool_use' && next && (next.category === 'tool_result' || next.id.startsWith('tool-result:'))) {
      rows.push({ kind: 'tool', use: event, result: next })
      index++
    } else {
      rows.push({ kind: 'event', event })
    }
  }
  return rows
}

function TaskOutputHistory({ task, visible, presentation, events }: {
  task: Task
  visible: boolean
  presentation: ReturnType<typeof taskIssuePresentation>
  events: TaskEvent[] | undefined
}): JSX.Element {
  const history = useStore((s) => s.taskEventHistory?.taskId === task.id ? s.taskEventHistory : null)
  const loadTaskEvents = useStore((s) => s.loadTaskEvents)
  const outputRef = useRef<HTMLDivElement>(null)
  const anchor = useRef<Anchor | null>(null)
  const [follow, setFollow] = useState(true)
  const attempt = useRef<Direction>('initial')
  const pending = useRef<Direction | null>(null)
  const needsHistory = history === null
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(new Set())
  const [silentCategories, setSilentCategories] = useState<ReadonlySet<TaskEventCategory>>(new Set())
  const [query, setQuery] = useState('')
  const [newCount, setNewCount] = useState(0)
  const tailBaseline = useRef(0)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const copyTimer = useRef(0)
  const seen = useRef<Set<string> | null>(null)

  const toggleExpanded = useCallback((id: string): void => {
    setExpandedIds((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const captureAnchor = (): void => {
    const output = outputRef.current
    if (!output || !visible) return
    const top = output.getBoundingClientRect().top
    const row = Array.from(output.querySelectorAll<HTMLElement>('[data-event-id]'))
      .find((row) => row.getBoundingClientRect().bottom > top)
    anchor.current = row ? { id: row.dataset.eventId!, offset: row.getBoundingClientRect().top - top } : null
  }

  useEffect(() => {
    if (!needsHistory) return
    anchor.current = null
    pending.current = null
    attempt.current = 'initial'
    seen.current = null
    setFollow(true)
    setNewCount(0)
    setExpandedIds(new Set())
    void loadTaskEvents(task.id)
  }, [loadTaskEvents, task.id, needsHistory])

  const load = (direction: Direction): void => {
    captureAnchor()
    attempt.current = direction
    pending.current = direction
    void loadTaskEvents(task.id, direction)
  }

  useLayoutEffect(() => {
    const output = outputRef.current
    if (!output || !visible) return
    const completed = pending.current && !history?.loading
    const jump = completed && !history?.error && pending.current === 'latest'
    if (jump) {
      output.scrollTo({ top: output.scrollHeight, behavior: scrollBehavior() })
      setFollow(true)
    } else if (follow && history?.followingLatest) {
      output.scrollTop = output.scrollHeight
    } else if (anchor.current) {
      // A stable event ID survives prepends and trimming the opposite window edge.
      // Disable native anchoring below so it does not compete with this adjustment.
      const row = output.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(anchor.current.id)}"]`)
      if (row) output.scrollTop += row.getBoundingClientRect().top - output.getBoundingClientRect().top - anchor.current.offset
      else if (completed && !history?.error) output.scrollTop = output.scrollHeight
    }
    if (completed) pending.current = null
    if (jump || (follow && history?.followingLatest)) anchor.current = null
    else captureAnchor()
  }, [events, history, follow, visible, task.status, task.deliveryStatus, presentation])

  // Rows animate in only when they arrive live at the tail; history pages and
  // in-place snapshot updates reuse existing IDs and stay still.
  if (events && seen.current === null && history?.loaded) seen.current = new Set(events.map((event) => event.id))
  const fresh = new Set<string>()
  if (events && seen.current) {
    for (const event of events) {
      if (seen.current.has(event.id)) continue
      if (history?.followingLatest) fresh.add(event.id)
      seen.current.add(event.id)
    }
  }

  const rows = useMemo(() => buildRows(events), [events])
  const normalizedQuery = query.trim().toLowerCase()
  const filtering = silentCategories.size > 0 || normalizedQuery.length > 0
  const eventHidden = useCallback((event: TaskEvent): boolean => {
    if (silentCategories.has(event.category)) return true
    return normalizedQuery.length > 0 && !event.text.toLowerCase().includes(normalizedQuery)
  }, [silentCategories, normalizedQuery])
  const visibleCount = useMemo(() =>
    (events ?? []).reduce((count, event) => count + (eventHidden(event) ? 0 : 1), 0),
  [events, eventHidden])
  const categoryCounts = useMemo(() => {
    const counts = new Map<TaskEventCategory, number>()
    for (const event of events ?? []) counts.set(event.category, (counts.get(event.category) ?? 0) + 1)
    return counts
  }, [events])

  useEffect(() => {
    if (follow || !history?.followingLatest) {
      setNewCount(0)
      return
    }
    setNewCount(Math.max(0, (events?.length ?? 0) - tailBaseline.current))
  }, [events, follow, history?.followingLatest])

  const scrollToTail = (): void => {
    const output = outputRef.current
    if (!output) return
    output.scrollTo({ top: output.scrollHeight, behavior: scrollBehavior() })
    setFollow(true)
    setNewCount(0)
  }

  const copyEvent = useCallback((id: string, text: string): void => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedId(id)
      window.clearTimeout(copyTimer.current)
      copyTimer.current = window.setTimeout(() => setCopiedId(null), 1200)
    }).catch(() => {
      // Clipboard unavailable (permissions); the button simply stays idle.
    })
  }, [])

  return (
    <section id="task-panel-output" aria-label="Output" className={cn('flex flex-1 min-h-0 min-w-0', !visible && 'hidden')}>
      <div className="flex flex-1 min-h-0 min-w-0 flex-col">
        <nav aria-label="Output history" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-5 py-1.5 text-xs">
          <span role="status" className="text-dim">{history?.loading ? 'Loading output…' : history?.loaded ? `${filtering ? `${visibleCount} of ` : ''}${events?.length ?? 0} events · ${history.followingLatest ? 'Latest' : 'History'}` : ''}</span>
          <QuickCommitActions task={task} />
        </nav>
        <div role="toolbar" aria-label="Output filters" className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-line px-5 py-1.5">
          {TASK_EVENT_CATEGORIES.map((category) => {
            const silent = silentCategories.has(category)
            return <button key={category} aria-pressed={!silent}
              title={`${silent ? 'Show' : 'Hide'} ${CATEGORY_LABEL[category]} events`}
              className={cn('flex items-center gap-1.5 border px-2 py-0.5 text-[11px] transition-colors',
                silent ? 'border-line/50 text-dim/40' : 'border-line text-dim hover:text-fg')}
              onClick={() => setSilentCategories((current) => {
                const next = new Set(current)
                if (next.has(category)) next.delete(category)
                else next.add(category)
                return next
              })}>
              <span aria-hidden className={cn('size-[6px] rounded-full', CATEGORY_DOT[category])} />
              {CATEGORY_LABEL[category]}
              <span aria-hidden className="text-dim/60">{categoryCounts.get(category) ?? 0}</span>
            </button>
          })}
          <label className="ml-auto flex items-center gap-1.5 text-dim">
            <Icon icon="search" size={12} aria-hidden="true" />
            <input type="text" value={query} aria-label="Filter output" placeholder="Filter output…"
              onChange={(event) => setQuery(event.target.value)}
              className="w-44 bg-transparent text-xs text-fg outline-none placeholder:text-dim/60" />
          </label>
        </div>
        {history?.error && <div role="alert" className="shrink-0 px-5 py-2 text-xs text-danger">
          {history.error}
          <button className={cn(btn.ghost, 'ml-3')} onClick={() => load(attempt.current)}>Retry output</button>
        </div>}
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div ref={outputRef} role="log" aria-label="Task output" aria-busy={!!history?.loading}
            className="flex-1 min-h-0 min-w-0 px-5 pb-3 overflow-y-auto overscroll-contain [overflow-anchor:none] font-mono text-[12.5px] leading-[1.55]"
            onScroll={(event) => {
              if (!visible) return
              const output = event.currentTarget
              const atTail = history?.followingLatest === true && output.scrollHeight - output.scrollTop - output.clientHeight < 40
              if (atTail) {
                setFollow(true)
                setNewCount(0)
                anchor.current = null
              } else {
                if (follow) tailBaseline.current = events?.length ?? 0
                setFollow(false)
                captureAnchor()
              }
            }}>
            <PromptBlock label="Prompt" text={task.prompt} />
            {!history?.loaded && !history?.error && <div role="status" aria-label="Loading output" className="space-y-2.5 py-6">
              {[72, 88, 54, 80, 63].map((width) => (
                <div key={width} className="h-3 bg-line/60 motion-safe:animate-breathe" style={{ width: `${width}%` }} />
              ))}
            </div>}
            {history?.loaded && events?.length === 0 && task.status !== 'running' && <p className={PLACEHOLDER}>No output recorded.</p>}
            {history?.loaded && history.hasOlder && <div className="flex justify-center py-1.5">
              <button className={cn(btn.ghost, 'py-1 text-xs')} disabled={!!history.loading} onClick={() => load('older')}>
                {history.loading === 'older' ? 'Loading earlier…' : 'Load earlier events'}
              </button>
            </div>}
            {rows.map((row) => row.kind === 'tool'
              ? <ToolRow key={row.use.id} use={row.use} result={row.result}
                useExpanded={expandedIds.has(row.use.id)} resultExpanded={expandedIds.has(row.result.id)}
                useHidden={eventHidden(row.use)} resultHidden={eventHidden(row.result)}
                useCopied={copiedId === row.use.id} resultCopied={copiedId === row.result.id}
                animate={fresh.has(row.use.id)} onToggle={toggleExpanded} onCopy={copyEvent} />
              : <EventRow key={row.event.id} event={row.event} expanded={expandedIds.has(row.event.id)}
                hidden={eventHidden(row.event)} copied={copiedId === row.event.id}
                animate={fresh.has(row.event.id)} onToggle={toggleExpanded} onCopy={copyEvent} />)}
            {filtering && visibleCount === 0 && (events?.length ?? 0) > 0 && <p className={PLACEHOLDER}>No events match the current filters.</p>}
            <TaskActivity task={task} presentation={presentation} event={history?.followingLatest ? events?.at(-1) : undefined} />
          </div>
          {newCount > 0 && !follow && history?.followingLatest === true ? <button
            className="absolute bottom-3 right-4 z-10 border border-line bg-raised px-3 py-1 text-xs text-fg shadow-[0_8px_32px_rgba(0,0,0,0.4)] hover:bg-hover motion-safe:animate-row-in"
            onClick={() => {
              if (history?.hasNewer) load('latest')
              else scrollToTail()
            }}>
            ↓ {newCount} new event{newCount === 1 ? '' : 's'}
          </button> : (!follow || history?.hasNewer || history?.followingLatest === false) && <button
            aria-label="Jump to latest" disabled={!!history?.loading}
            className="absolute bottom-3 right-4 z-10 flex size-7 items-center justify-center border border-line bg-raised text-dim shadow-[0_8px_32px_rgba(0,0,0,0.4)] hover:text-fg disabled:opacity-45 motion-safe:animate-row-in"
            onClick={() => load('latest')}>
            <Icon icon="chevron-down" size={14} aria-hidden="true" />
          </button>}
        </div>
      </div>
      <BrowserObservationPane taskId={task.id} visible={visible} />
    </section>
  )
}

function BrowserObservationPane({ taskId, visible }: { taskId: string; visible: boolean }): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [viewport, setViewport] = useState<BrowserViewport>('desktop')
  const [paneSize, setPaneSize] = useState<{ width: number; height: number } | null>(null)
  const paneRef = useRef<HTMLElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let active = true
    let changed = false
    const stop = window.anvil.browser.onChanged((state) => {
      if (state.taskId !== taskId) return
      changed = true
      if (active) {
        setOpen(state.open)
        setViewport(state.viewport)
      }
    })
    void window.anvil.browser.state(taskId).then((state) => {
      if (active && !changed) {
        setOpen(state.open)
        setViewport(state.viewport)
      }
    }).catch(() => {})
    return () => {
      active = false
      stop()
    }
  }, [taskId])

  useLayoutEffect(() => {
    const pane = paneRef.current
    const container = pane?.parentElement
    if (!open || !visible || !pane || !container) {
      setPaneSize(null)
      return
    }
    const dimensions = BROWSER_VIEWPORTS[viewport]
    const measure = (): void => {
      const maximumWidth = Math.floor(container.clientWidth * BROWSER_MAX_WIDTH_RATIO)
      const maximumHeight = container.clientHeight - BROWSER_HEADER_HEIGHT
      if (maximumWidth < 1 || maximumHeight < 1) return
      const scale = Math.min(1, maximumWidth / dimensions.width, maximumHeight / dimensions.height)
      const next = {
        width: Math.max(1, Math.floor(dimensions.width * scale)),
        height: Math.max(1, Math.floor(dimensions.height * scale))
      }
      setPaneSize((current) => current?.width === next.width && current.height === next.height ? current : next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [open, viewport, visible])

  useLayoutEffect(() => {
    const frame = frameRef.current
    const hidden = { taskId, visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } }
    const place = (layout: Parameters<typeof window.anvil.browser.layout>[0]): void => {
      void window.anvil.browser.layout(layout).catch(() => {})
    }
    if (!open || !visible || !frame) {
      place(hidden)
      return
    }
    let animationFrame = 0
    const measure = (): void => {
      animationFrame = 0
      const bounds = frame.getBoundingClientRect()
      place({
        taskId,
        visible: bounds.width >= 1 && bounds.height >= 1,
        bounds: {
          x: Math.max(0, Math.round(bounds.x)),
          y: Math.max(0, Math.round(bounds.y)),
          width: Math.max(0, Math.round(Math.min(bounds.width, window.innerWidth - bounds.x))),
          height: Math.max(0, Math.round(Math.min(bounds.height, window.innerHeight - bounds.y)))
        }
      })
    }
    const schedule = (): void => {
      if (!animationFrame) animationFrame = window.requestAnimationFrame(measure)
    }
    measure()
    const observer = new ResizeObserver(schedule)
    observer.observe(frame)
    window.addEventListener('resize', schedule)
    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      place(hidden)
    }
  }, [open, taskId, viewport, visible])

  if (!open) return null
  const dimensions = BROWSER_VIEWPORTS[viewport]
  const nextViewport = viewport === 'desktop' ? 'mobile' : 'desktop'
  return (
    <section ref={paneRef} aria-label="Agent browser" style={paneSize ? { width: paneSize.width, height: paneSize.height + BROWSER_HEADER_HEIGHT } : undefined}
      className={cn('flex min-h-0 shrink-0 self-start flex-col overflow-hidden border-l border-line', !paneSize && 'h-full w-[48%]')}>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line px-3 text-[11px] font-medium text-dim">
        <span>Browser</span>
        <span>{dimensions.width} × {dimensions.height}</span>
        <button className={cn(btn.ghost, 'ml-auto px-2 py-0.5 text-[11px]')} aria-label={`Switch browser to ${nextViewport} view`}
          onClick={() => { void window.anvil.browser.viewport({ taskId, viewport: nextViewport }).catch(() => {}) }}>
          {nextViewport === 'mobile' ? 'Mobile' : 'Desktop'}
        </button>
      </div>
      <div ref={frameRef} className="min-h-0 flex-1 bg-canvas" />
    </section>
  )
}

/**
 * The prompt opens the transcript rather than sitting above it: long prompts
 * clamp instead of squeezing the output, and reading one is a scroll away.
 */
function PromptBlock({ label, text }: { label: string; text: string }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [clamped, setClamped] = useState(false)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = (): void => {
      if (!expanded) setClamped(element.scrollHeight > element.clientHeight + 1)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [expanded, text])

  return (
    <section role="region" aria-label="Task prompt" tabIndex={0} className="my-3 border-l-2 border-accent/50 pl-3.5 font-sans focus-visible:outline focus-visible:outline-accent">
      <div className="mb-1 flex items-center gap-3 text-[11px] text-dim">
        <span className="font-medium">{label}</span>
        {(clamped || expanded) && <button className="text-accent hover:underline" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>}
      </div>
      <div ref={ref} className={cn('text-[13px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]', !expanded && 'line-clamp-6')}>
        {text}
      </div>
    </section>
  )
}

const CATEGORY_LABEL: Record<TaskEventCategory, string> = {
  message: 'message',
  thinking: 'thinking',
  tool_use: 'tool_use',
  tool_result: 'tool_result',
  system: 'system',
  error: 'error'
}

/* One colour per stream, so a log skims by kind. A row that reports the agent
 * never committing is amber whatever category carried it. */
const KIND_TONE: Record<TaskEventCategory, string> = {
  message: 'text-accent',
  thinking: 'text-violet',
  tool_use: 'text-accent',
  tool_result: 'text-cyan',
  system: 'text-ok',
  error: 'text-danger'
}

const CATEGORY_DOT: Record<TaskEventCategory, string> = {
  message: 'bg-accent',
  thinking: 'bg-violet',
  tool_use: 'bg-accent',
  tool_result: 'bg-cyan',
  system: 'bg-ok',
  error: 'bg-danger'
}

const TEXT_TONE: Record<TaskEventCategory, string> = {
  message: 'text-fg',
  thinking: 'italic text-dim',
  tool_use: '',
  tool_result: 'text-dim',
  system: 'text-dim',
  error: 'text-danger'
}

/* Prose categories read in the UI font; the machine streams stay monospace. */
const PROSE: Partial<Record<TaskEventCategory, string>> = {
  message: 'font-sans text-[13px] leading-relaxed',
  thinking: 'font-sans'
}

/* How much of each stream shows before a row offers expansion. Agent messages
 * get room to speak; tool results stay a single skim line. */
const CLAMP_LINES: Record<TaskEventCategory, number> = {
  message: 15,
  thinking: 6,
  tool_use: 2,
  tool_result: 1,
  system: 2,
  error: 3
}

const LINE_CLAMP: Record<number, string> = {
  1: 'line-clamp-1',
  2: 'line-clamp-2',
  3: 'line-clamp-3',
  6: 'line-clamp-6',
  15: 'line-clamp-15'
}

/* Measuring every row would cost a layout pass per event; long lines wrap, so
 * a character budget per line is close enough to decide "can this clamp". */
function clampable(text: string, lines: number): boolean {
  return text.split('\n').length > lines || text.length > lines * 80
}

function ExpandButton({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }): JSX.Element {
  return (
    <button type="button" aria-label={expanded ? 'Collapse event' : 'Expand event'} aria-expanded={expanded}
      onClick={(event) => {
        event.stopPropagation()
        onToggle()
      }}
      className="-ml-1 mt-px flex size-4 shrink-0 items-center justify-center text-dim/50 hover:text-fg">
      <Icon icon="chevron-right" size={12} aria-hidden="true" className={cn('transition-transform duration-150', expanded && 'rotate-90')} />
    </button>
  )
}

/* Copies one event's text; revealed on row hover so the stream stays clean. */
function CopyButton({ copied, onCopy }: { copied: boolean; onCopy: () => void }): JSX.Element {
  return (
    <button type="button" aria-label={copied ? 'Copied' : 'Copy event'}
      onClick={(event) => {
        event.stopPropagation()
        onCopy()
      }}
      className={cn('absolute right-1 top-1 z-10 flex size-5 items-center justify-center border border-line bg-raised text-dim transition-opacity hover:text-fg focus-visible:opacity-100',
        copied ? 'opacity-100 text-ok' : 'opacity-0 group-hover:opacity-100')}>
      <Icon icon={copied ? 'check' : 'copy'} size={11} aria-hidden="true" />
    </button>
  )
}

function Gutter({ event, label, tone, expandable, expanded, onToggle }: {
  event: TaskEvent
  label: string
  tone: string
  expandable: boolean
  expanded: boolean
  onToggle: () => void
}): JSX.Element {
  return (
    <span className="flex select-none flex-col gap-0.5">
      <span className="flex items-center gap-1">
        {expandable && <ExpandButton expanded={expanded} onToggle={onToggle} />}
        <span className={cn('text-[11px]', tone)}>{label}</span>
      </span>
      <time dateTime={new Date(event.ts).toISOString()} className="text-[10px] leading-tight text-dim/50 tabular-nums">
        {timeFormat.format(event.ts)}
      </time>
    </span>
  )
}

function ClampedText({ text, lines, expanded, className, showMoreLink, onToggle }: {
  text: string
  lines: number
  expanded: boolean
  className?: string
  showMoreLink?: boolean
  onToggle?: () => void
}): JSX.Element {
  const truncatable = clampable(text, lines)
  return (
    <span className="relative block min-w-0">
      <span className={cn('whitespace-pre-wrap break-words [overflow-wrap:anywhere]', expanded ? 'block' : truncatable && LINE_CLAMP[lines], className)}>
        {text || ' '}
      </span>
      {!expanded && truncatable && <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-5 bg-gradient-to-t from-canvas to-transparent" />}
      {truncatable && showMoreLink && onToggle && <button type="button" aria-expanded={expanded}
        onClick={(event) => {
          event.stopPropagation()
          onToggle()
        }}
        className="mt-0.5 text-[11px] text-accent hover:underline">
        {expanded ? 'Show less' : 'Show more'}
      </button>}
    </span>
  )
}

function ToolUseContent({ event, expanded, onToggle }: {
  event: TaskEvent
  expanded: boolean
  onToggle: (id: string) => void
}): JSX.Element {
  const [toolName, ...toolDescription] = event.text.split('\n')
  const description = toolDescription.join('\n')
  return (
    <span className="min-w-0">
      <span className="block break-words">{toolName}</span>
      {description && <ClampedText text={description} lines={CLAMP_LINES.tool_use} expanded={expanded}
        className="text-dim" onToggle={() => onToggle(event.id)} />}
    </span>
  )
}

function ToolResultRow({ result, expanded, hidden, copied, onToggle, onCopy }: {
  result: TaskEvent
  expanded: boolean
  hidden: boolean
  copied: boolean
  onToggle: (id: string) => void
  onCopy: (id: string, text: string) => void
}): JSX.Element {
  const failed = result.category === 'error'
  return (
    <div data-event-id={result.id} data-output-category={result.category} aria-expanded={expanded}
      className={cn('group relative mt-1 flex items-start gap-2 border-l border-line pl-2.5', hidden && 'hidden')}>
      <ExpandButton expanded={expanded} onToggle={() => onToggle(result.id)} />
      <span className="min-w-0 flex-1">
        <span className={cn('block text-[10px] uppercase tracking-wide select-none', failed ? 'text-danger' : KIND_TONE.tool_result)}>
          {failed ? 'error' : 'result'}
        </span>
        <ClampedText text={result.text} lines={CLAMP_LINES.tool_result} expanded={expanded}
          className={failed ? 'text-danger' : 'text-dim'} onToggle={() => onToggle(result.id)} />
      </span>
      <CopyButton copied={copied} onCopy={() => onCopy(result.id, result.text)} />
    </div>
  )
}

const ToolRow = memo(function ToolRow({ use, result, useExpanded, resultExpanded, useHidden, resultHidden, useCopied, resultCopied, animate, onToggle, onCopy }: {
  use: TaskEvent
  result: TaskEvent
  useExpanded: boolean
  resultExpanded: boolean
  useHidden: boolean
  resultHidden: boolean
  useCopied: boolean
  resultCopied: boolean
  animate: boolean
  onToggle: (id: string) => void
  onCopy: (id: string, text: string) => void
}): JSX.Element {
  const mcpTool = /^mcp(?:__|[_ -])/i.test(use.text.split('\n', 1)[0]) || use.text.split('\n', 1)[0].includes('/')
  return (
    <div data-output-category={mcpTool ? 'mcp_tool' : 'tool_use'} data-event-id={use.id} aria-expanded={useExpanded}
      className={cn('group relative grid grid-cols-[88px_minmax(0,1fr)] items-start gap-4 py-1.5 border-b border-line/55 last:border-b-0 hover:bg-hover/45',
        animate && 'motion-safe:animate-row-in', useHidden && 'hidden')}>
      <Gutter event={use} label={mcpTool ? 'mcp_tool' : 'tool_use'} tone={mcpTool ? 'text-violet' : KIND_TONE.tool_use}
        expandable expanded={useExpanded} onToggle={() => onToggle(use.id)} />
      <span className="min-w-0">
        <ToolUseContent event={use} expanded={useExpanded} onToggle={onToggle} />
        <ToolResultRow result={result} expanded={resultExpanded} hidden={resultHidden} copied={resultCopied} onToggle={onToggle} onCopy={onCopy} />
      </span>
      <CopyButton copied={useCopied} onCopy={() => onCopy(use.id, use.text)} />
    </div>
  )
})

const EventRow = memo(function EventRow({ event, expanded, hidden, copied, animate, onToggle, onCopy }: {
  event: TaskEvent
  expanded: boolean
  hidden: boolean
  copied: boolean
  animate: boolean
  onToggle: (id: string) => void
  onCopy: (id: string, text: string) => void
}): JSX.Element {
  const uncommitted = event.kind === 'did_not_commit'
  const tool = event.category === 'tool_use'
  const mcpTool = tool && (/^mcp(?:__|[_ -])/i.test(event.text.split('\n', 1)[0]) || event.text.split('\n', 1)[0].includes('/'))
  const toolResult = event.category === 'tool_result' || event.id.startsWith('tool-result:')
  const lines = toolResult ? CLAMP_LINES.tool_result : CLAMP_LINES[event.category]
  const prose = PROSE[event.category]
  const expandable = tool || toolResult || clampable(event.text, lines)
  return (
    <div data-output-category={mcpTool ? 'mcp_tool' : event.category} data-event-id={event.id} aria-expanded={expanded}
      className={cn('group relative grid grid-cols-[88px_minmax(0,1fr)] items-start gap-4 py-1.5 border-b border-line/55 last:border-b-0 hover:bg-hover/45',
        animate && 'motion-safe:animate-row-in', hidden && 'hidden')}>
      <Gutter event={event} label={mcpTool ? 'mcp_tool' : CATEGORY_LABEL[event.category]}
        tone={uncommitted ? 'text-warn' : mcpTool ? 'text-violet' : KIND_TONE[event.category]}
        expandable={expandable} expanded={expanded} onToggle={() => onToggle(event.id)} />
      {tool ? <ToolUseContent event={event} expanded={expanded} onToggle={onToggle} /> :
        <span className={cn('min-w-0', event.category === 'message' && 'block border-l-2 border-accent/50 py-0.5 pl-3')}>
          <ClampedText text={event.text} lines={lines} expanded={expanded}
            className={cn(prose, uncommitted ? 'text-warn' : TEXT_TONE[event.category])}
            showMoreLink={event.category === 'message' || event.category === 'thinking'}
            onToggle={() => onToggle(event.id)} />
        </span>}
      <CopyButton copied={copied} onCopy={() => onCopy(event.id, event.text)} />
    </div>
  )
})
