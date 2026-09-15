import type { JSX } from 'react'
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Task, TaskEvent, TaskEventCategory } from '@shared/types'
import type { taskIssuePresentation } from '@shared/task-issue-presentation'
import { BROWSER_VIEWPORTS, type BrowserViewport } from '@shared/browser-observation'
import { useStore } from '../state/store'
import { btn, cn } from '../ui'
import { TaskActivity } from './TaskActivity'

const PLACEHOLDER = 'py-8 text-center text-dim'
const BROWSER_HEADER_HEIGHT = 32
const BROWSER_MAX_WIDTH_RATIO = 0.48

type Direction = 'initial' | 'latest'
type Anchor = { id: string; offset: number }

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
    setFollow(true)
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
    if (jump || (follow && history?.followingLatest)) {
      output.scrollTop = output.scrollHeight
      if (jump) setFollow(true)
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

  return (
    <section id="task-panel-output" aria-label="Output" className={cn('flex flex-1 min-h-0 min-w-0', !visible && 'hidden')}>
      <div className="flex flex-1 min-h-0 min-w-0 flex-col">
        <nav aria-label="Output history" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-5 py-1.5 text-xs">
          <span role="status" className="text-dim">{history?.loading ? 'Loading output…' : history?.loaded ? `${events?.length ?? 0} events · ${history.followingLatest ? 'Latest' : 'History'}` : ''}</span>
          {(!follow || history?.hasNewer || history?.followingLatest === false) && <button className={cn(btn.ghost, 'ml-auto py-1 text-xs')} disabled={!!history?.loading} onClick={() => load('latest')}>Jump to latest</button>}
        </nav>
        {history?.error && <div role="alert" className="shrink-0 px-5 py-2 text-xs text-danger">
          {history.error}
          <button className={cn(btn.ghost, 'ml-3')} onClick={() => load(attempt.current)}>Retry output</button>
        </div>}
        <div ref={outputRef} role="log" aria-label="Task output" aria-busy={!!history?.loading}
          className="flex-1 min-h-0 min-w-0 px-5 pb-3 overflow-y-auto overscroll-contain [overflow-anchor:none] font-mono text-[12.5px] leading-[1.55]"
          onScroll={(event) => {
            if (!visible) return
            const output = event.currentTarget
            const atTail = history?.followingLatest === true && output.scrollHeight - output.scrollTop - output.clientHeight < 40
            setFollow(atTail)
            if (atTail) anchor.current = null
            else captureAnchor()
          }}>
          <PromptBlock label="Prompt" text={task.prompt} />
          {!history?.loaded && !history?.error && <p className={PLACEHOLDER}>Loading output…</p>}
          {history?.loaded && events?.length === 0 && task.status !== 'running' && <p className={PLACEHOLDER}>No output recorded.</p>}
          {events?.map((event) => <LogRow key={event.id} event={event} />)}
          <TaskActivity task={task} presentation={presentation} event={history?.followingLatest ? events?.at(-1) : undefined} />
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
  message: 'text-dim',
  thinking: 'text-violet',
  tool_use: 'text-accent',
  tool_result: 'text-cyan',
  system: 'text-ok',
  error: 'text-danger'
}

const TEXT_TONE: Record<TaskEventCategory, string> = {
  message: '',
  thinking: 'italic text-dim',
  tool_use: '',
  tool_result: 'text-dim',
  system: 'text-dim',
  error: 'text-danger'
}

function LogRow({ event }: { event: TaskEvent }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const uncommitted = event.kind === 'did_not_commit'
  const [toolName, ...toolDescription] = event.category === 'tool_use' ? event.text.split('\n') : []
  const tool = toolName ? { name: toolName, description: toolDescription.join('\n') } : undefined
  const toolResult = event.category === 'tool_result' || event.id.startsWith('tool-result:')
  return (
    <div
      data-output-category={event.category}
      data-event-id={event.id}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      className="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-4 py-1.5 cursor-pointer border-b border-line/55 last:border-b-0 hover:bg-hover/45"
      onClick={() => setExpanded((value) => !value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          setExpanded((value) => !value)
        }
      }}
    >
      <span className={cn('text-[11px] select-none', uncommitted ? 'text-warn' : KIND_TONE[event.category])}>
        {CATEGORY_LABEL[event.category]}
      </span>
      <span className="min-w-0">
        {tool ? <>
          <span className="block break-words">{tool.name}</span>
          {tool.description && <span className={cn('whitespace-pre-wrap break-words text-dim', expanded ? 'block' : 'line-clamp-2')}>
            {tool.description}
          </span>}
        </> : <span
          className={cn(
            'min-w-0 whitespace-pre-wrap break-words',
            expanded ? 'block' : toolResult ? 'line-clamp-1' : 'line-clamp-3',
            uncommitted ? 'text-warn' : TEXT_TONE[event.category]
          )}
        >
          {event.text || ' '}
        </span>}
      </span>
    </div>
  )
}
