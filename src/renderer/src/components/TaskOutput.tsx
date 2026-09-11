import type { JSX } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Task, TaskEvent, TaskEventCategory } from '@shared/types'
import type { taskIssuePresentation } from '@shared/task-issue-presentation'
import { useStore } from '../state/store'
import { btn, cn } from '../ui'
import { TaskActivity } from './TaskActivity'

const PLACEHOLDER = 'py-8 text-center text-dim'

type Direction = 'initial' | 'older' | 'newer' | 'latest'
type Anchor = { id: string; offset: number }

export function TaskOutput({ task, visible, presentation }: {
  task: Task
  visible: boolean
  presentation: ReturnType<typeof taskIssuePresentation>
}): JSX.Element {
  const events = useStore((s) => s.eventsByTask[task.id])
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
    if (direction === 'older' || direction === 'newer') setFollow(false)
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
      else if (completed && !history?.error) output.scrollTop = pending.current === 'older' ? 0 : output.scrollHeight
    }
    if (completed) pending.current = null
    if (jump || (follow && history?.followingLatest)) anchor.current = null
    else captureAnchor()
  }, [events, history, follow, visible, task.status, task.deliveryStatus, presentation])

  return (
    <section id="task-panel-output" aria-label="Output" className={cn('flex flex-col flex-1 min-h-0 min-w-0', !visible && 'hidden')}>
      <nav aria-label="Output history" className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-5 py-1.5 text-xs">
        <button className={cn(btn.ghost, 'py-1 text-xs')} disabled={!history?.hasOlder || !!history.loading} onClick={() => load('older')}>Older output</button>
        <button className={cn(btn.ghost, 'py-1 text-xs')} disabled={!history?.hasNewer || !!history.loading} onClick={() => load('newer')}>Newer output</button>
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
