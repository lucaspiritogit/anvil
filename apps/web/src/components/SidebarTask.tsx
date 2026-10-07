import { isQueuedStackTask } from '@anvil/protocol/task-stacks'
import type { ComponentPropsWithRef, CSSProperties, JSX, ReactNode } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Icon, type IconName } from '../icons'
import type { Project, Task, TaskIssueSnapshot, TaskStackOrigin } from '@anvil/protocol/types'
import { taskIssuePresentation } from '@anvil/protocol/task-issue-presentation'
import { canSettleTask, settlementDeadline } from '@anvil/protocol/task-settlement'
import { isTaskFinishedUnseen } from '@anvil/protocol/task-review'
import { useStore } from '../state/store'
import { IS_MAC } from '../keys'
import { cn } from '../ui'
import { openTaskContextMenu } from './TaskContextMenu'
import { TASK_STYLE_LABELS, taskStyle } from '@anvil/protocol/task-style'
import { StatusGlyph, type StatusGlyphName } from './StatusGlyph'
import type { SidebarStackTree } from './sidebar-task-stacks'

const TASK_INDICATORS = {
  queued: { glyph: 'queued', label: 'Queued', tone: 'text-idle', meta: 'text-dim' },
  running: { glyph: 'running', label: 'Working', tone: 'text-run', meta: 'text-run-text' },
  done: { glyph: 'done', label: 'Done', tone: 'text-ok', meta: 'text-ok-text' },
  reviewedIssue: { glyph: 'done', label: 'Approved', tone: 'text-ok', meta: 'text-ok-text' },
  merged: { glyph: 'done', icon: 'git-branch', label: 'Merged', tone: 'text-ok', meta: 'text-ok-text' },
  openPullRequest: { glyph: 'done', icon: 'git-branch', label: 'Open PR', tone: 'text-ok', meta: 'text-ok-text' },
  reviewable: { glyph: 'review', label: 'Ready for review', tone: 'text-review', meta: 'text-review-text' },
  failed: { glyph: 'failed', label: 'Failed', tone: 'text-danger', meta: 'text-danger-text' }
} as const satisfies Record<string, { glyph: StatusGlyphName; icon?: IconName; label: string; tone: string; meta: string }>

const STYLE_GLYPHS = { work: '▣', quick: '»' } as const

function taskIndicator(task: Task, finishedUnseen: boolean): typeof TASK_INDICATORS[keyof typeof TASK_INDICATORS] | undefined {
  if (task.deliveryStatus === 'finalizing' || task.deliveryStatus === 'did_not_commit') return TASK_INDICATORS.running
  if (task.status === 'pending') return TASK_INDICATORS.queued
  if (task.status === 'running') return TASK_INDICATORS.running
  if (task.status === 'failed' || task.deliveryStatus === 'failed' || task.deliveryStatus === 'agent_failed') {
    return TASK_INDICATORS.failed
  }
  if (task.status === 'succeeded') {
    if (task.deliveryStatus === 'reviewable' && task.pullRequest) return TASK_INDICATORS.openPullRequest
    if (task.deliveryStatus === 'reviewable') return TASK_INDICATORS.reviewable
    if (taskStyle(task) !== 'work' || task.deliveryStatus === 'no_changes') {
      return finishedUnseen ? TASK_INDICATORS.reviewable : TASK_INDICATORS.done
    }
    if (task.deliveryStatus === 'approved') return TASK_INDICATORS.merged
  }
  return undefined
}

function taskIssueIndicator(presentation: NonNullable<ReturnType<typeof taskIssuePresentation>>) {
  switch (presentation.status) {
    case 'queued':
      return { ...TASK_INDICATORS.queued, label: presentation.label }
    case 'working':
      return { ...TASK_INDICATORS.running, label: presentation.label }
    case 'review':
      return { ...TASK_INDICATORS.reviewable, label: presentation.label }
    case 'blocked':
      return { ...TASK_INDICATORS.failed, label: presentation.label }
    case 'complete':
      return {
        ...(presentation.issue.reviewedAt != null ? TASK_INDICATORS.reviewedIssue : TASK_INDICATORS.done),
        label: presentation.label
      }
  }
}

const expandedSubtasks = new Set<string>()

function relativeAge(timestamp: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000))
  if (minutes < 1) return 'now'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

const LANDING_MS = 2000

export function SidebarTask({ task, snapshot, project, now, active, compact = false, tree = null, onToggleStack, rowProps, onNavigate }: {
  task: Task
  snapshot?: TaskIssueSnapshot | null
  project?: Project
  now: number
  active: boolean
  compact?: boolean
  tree?: SidebarStackTree | null
  onToggleStack?: (rootId: string) => void
  onNavigate?: () => void
  rowProps?: ComponentPropsWithRef<'li'> & { 'data-index'?: number; 'data-task-id'?: string; 'data-stack-moving'?: boolean; 'data-row-start'?: number }
}): JSX.Element {
  const parent = useStore((state) => state.tasks.find((entry) => entry.id === (task.restackTarget?.parentTaskId ?? task.parentTaskId)))
  const queuedStack = isQueuedStackTask(task)
  const articleRef = useRef<HTMLElement>(null)
  const queuedHeight = useRef<number | null>(null)
  const openTask = useStore((state) => state.openTask)
  const settleTask = useStore((state) => state.settleTask)
  const seenAt = useStore((state) => state.taskSeenAt[task.id])
  const markTaskSeen = useStore((state) => state.markTaskSeen)
  const finishedUnseen = isTaskFinishedUnseen(task, seenAt)
  const [settling, setSettling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(() => expandedSubtasks.has(task.id))
  const toggleExpanded = (): void => {
    const next = !expanded
    setExpanded(next)
    if (next) expandedSubtasks.add(task.id)
    else expandedSubtasks.delete(task.id)
  }
  const childCount = snapshot?.children.length ?? 0
  const reviewCount = snapshot?.children.filter((issue) => issue.status === 'review').length ?? 0
  const hasChildren = childCount > 0
  const showChildren = compact || expanded
  const stackRoot = tree !== null && tree.depth === 0 && tree.size > 1
  const depth = Math.min(tree?.depth ?? 0, MAX_STACK_DEPTH)
  const leadWidth = depth > 0 ? branchWidth(depth) : 0
  const indent = 42 + (depth > 0 ? leadWidth + 10 : 0)
  const eligible = canSettleTask(task) && !stackRoot
  const blocked = Boolean(task.parentTaskId) && task.deliveryStatus === 'reviewable'
  const deadline = settlementDeadline(task)
  const presentation = taskIssuePresentation(task, snapshot)
  const indicator = queuedStack ? TASK_INDICATORS.queued : presentation ? taskIssueIndicator(presentation) : taskIndicator(task, finishedUnseen)
  const createdAt = useStore((state) => state.createdTask?.id === task.id ? state.createdTask.at : null)
  const [landing, setLanding] = useState(false)
  useEffect(() => {
    if (createdAt === null) return
    const remaining = createdAt + LANDING_MS - Date.now()
    if (remaining <= 0) return
    setLanding(true)
    const timer = setTimeout(() => setLanding(false), remaining)
    return () => clearTimeout(timer)
  }, [createdAt])
  const statusIcon = (
    <span role={indicator ? 'img' : undefined} aria-label={indicator?.label} title={indicator?.label} className={cn('flex w-4 shrink-0 justify-center', compact ? 'text-xs' : 'text-[13px]', landing ? 'text-ember-400' : indicator?.tone ?? 'text-faint')}>
      {landing ? <span aria-hidden="true" className="font-mono">◇</span>
        : indicator && 'icon' in indicator ? <Icon icon={indicator.icon} size={compact ? 14 : 15} aria-hidden="true" />
        : indicator ? <StatusGlyph glyph={indicator.glyph} />
          : <Icon icon="folder" size={compact ? 14 : 15} aria-hidden="true" />}
    </span>
  )

  useLayoutEffect(() => {
    const article = articleRef.current
    if (!article) return
    if (queuedStack) {
      queuedHeight.current = article.offsetHeight
      return
    }
    const previousHeight = queuedHeight.current
    queuedHeight.current = null
    if (previousHeight === null || previousHeight === article.offsetHeight ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    // Animate real height so the virtual list makes room without stretching text.
    article.dataset.expanding = 'true'
    const animation = article.animate([
      { height: `${previousHeight}px`, overflow: 'clip' },
      { height: `${article.offsetHeight}px`, overflow: 'clip' }
    ], { duration: 360, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
    animation.onfinish = () => { delete article.dataset.expanding }
    return () => {
      animation.cancel()
      delete article.dataset.expanding
    }
  }, [queuedStack, compact])

  useEffect(() => {
    if (active && finishedUnseen) markTaskSeen(task.id)
  }, [active, finishedUnseen, markTaskSeen, task.id])

  const settle = async (): Promise<void> => {
    if (settling) return
    setSettling(true)
    setError(null)
    try {
      await settleTask(task.id)
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error))
    } finally {
      setSettling(false)
    }
  }

  const title = [
    parent ? `${task.prompt}\n${task.stackOrigin === 'auto' ? 'Anvil stacked this on' : 'Stacked on'} ${parent.title}` : task.prompt,
    ...(blocked && parent ? [`Merge ${parent.title} first.`] : []),
    ...(task.pullRequest ? [task.pullRequest.url, `${IS_MAC ? '⌘' : 'Ctrl'}+click to open pull request`] : [])
  ].join('\n')

  const open = (event: React.MouseEvent<HTMLButtonElement>): void => {
    const primaryModifier = IS_MAC ? event.metaKey : event.ctrlKey
    if (task.pullRequest && primaryModifier) {
      event.preventDefault()
      setError(null)
      void window.anvil.github.openUrl(task.pullRequest.url).catch((error: unknown) => {
        setError(error instanceof Error ? error.message : String(error))
      })
      return
    }
    void openTask(task.id)
    onNavigate?.()
  }

  return (
    <li {...rowProps} className={cn(rowProps?.className, tree && (tree.stem || tree.next || tree.rails.some(Boolean)) && 'overflow-clip')}>
      <article
        ref={articleRef}
        className={cn(
          'group relative transition-colors duration-[120ms]',
          active ? 'row-selected' : 'hover:bg-hover',
          landing && 'sidebar-task-landed'
        )}
      >
        <button
          aria-label={`Open task: ${task.title}`}
          aria-current={active ? 'page' : undefined}
          className={cn('grid w-full min-w-0 gap-x-2.5 text-left focus-visible:outline focus-visible:-outline-offset-2 focus-visible:outline-accent', depth === 0 && 'grid-cols-[16px_minmax(0,1fr)_auto]', compact || queuedStack ? 'items-center px-4 py-2' : 'items-center px-4 py-2.5')}
          style={depth > 0 ? { gridTemplateColumns: `${leadWidth}px 16px minmax(0, 1fr) auto` } : undefined}
          onClick={open}
          onContextMenu={(event) => openTaskContextMenu(event, task.id)}
          title={title}
        >
          {depth > 0 && tree && <StackBranch tree={tree} depth={depth} width={leadWidth} tight={compact || queuedStack} />}
          {queuedStack ? (
            <>
              {tree?.stem ? <StackStem origin={tree.stem} tight={compact || queuedStack}>{statusIcon}</StackStem> : statusIcon}
              <span className="min-w-0 truncate text-xs text-soft">{task.title}</span>
              <span className={cn('shrink-0 font-mono text-[10px]', indicator?.tone ?? 'text-dim')}>
                Queued
              </span>
            </>
          ) : compact ? (
            <>
              {tree?.stem ? <StackStem origin={tree.stem} tight={compact || queuedStack}>{statusIcon}</StackStem> : statusIcon}
              <span className="min-w-0 truncate text-xs text-dim">{task.title}</span>
              <span className="shrink-0 font-mono text-[10px] text-faint">{relativeAge(task.settledAt ?? task.startedAt, now)}</span>
            </>
          ) : (
            <>
              {tree?.stem ? <StackStem origin={tree.stem} tight={compact || queuedStack}>{statusIcon}</StackStem> : statusIcon}
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className={cn('truncate text-[13px] font-medium', active || task.status === 'running' ? 'text-fg' : 'text-soft')}>
                  {task.title}
                </span>
                <span className="flex min-w-0 items-center gap-1.5 font-mono text-[11px] leading-4">
                  {tree?.origin === 'auto' && <span className="shrink-0 text-ember-400" title="Anvil stacked this task because it touches the same files">⠿ anvil ·</span>}
                  <span className={cn('shrink-0 lowercase', indicator?.meta ?? 'text-dim')}>
                    {indicator?.label ?? (task.status === 'pending' ? 'Pending' : task.status === 'cancelled' ? 'Cancelled' : relativeAge(task.endedAt ?? task.startedAt, now))}
                  </span>
                  {task.reviewPolicy === 'review_at_task_end' && <span className="inline-flex shrink-0 text-warn" title="Runs unattended until the final review"><Icon icon="moon-star" size={11} aria-hidden="true" /><span className="sr-only">Review at the end</span></span>}
                  {task.restackState && <span className="shrink-0 text-warn">· restack {task.restackState}</span>}
                  <span aria-hidden="true" className="shrink-0 text-faint">·</span>
                  <span className="min-w-0 truncate text-faint">{tree?.collapsed ? `+${tree.size - 1} stacked${tree.hiddenWorking ? ` · ${tree.hiddenWorking} working` : ''}` : task.branchName ?? task.agentLabel}</span>
                </span>
              </span>
              <span className={cn('flex shrink-0 items-center', eligible && 'group-hover:invisible group-focus-within:invisible')}>
                {stackRoot
                  ? <span aria-hidden="true" className="invisible font-mono text-[11px]">{tree.size} ▸</span>
                  : blocked
                  ? <span aria-hidden="true" className="font-mono text-[12px] text-warn">⊘</span>
                  : reviewCount > 0
                  ? <span title={`${reviewCount} ${reviewCount === 1 ? 'subtask' : 'subtasks'} ready for review`} className="grid h-[18px] min-w-[18px] place-items-center bg-review px-1 font-mono text-[10px] font-semibold text-canvas">{reviewCount}</span>
                  : <span title={TASK_STYLE_LABELS[taskStyle(task)]} className="font-mono text-[11px] text-faint">{STYLE_GLYPHS[taskStyle(task)]}</span>}
              </span>
            </>
          )}
        </button>
        {stackRoot && !queuedStack && !compact && (
          <button
            type="button"
            aria-label={`${tree.collapsed ? 'Expand' : 'Collapse'} stack: ${task.title}`}
            aria-expanded={!tree.collapsed}
            title={tree.collapsed ? `Show ${tree.size - 1} stacked ${tree.size === 2 ? 'task' : 'tasks'}` : 'Collapse stack'}
            className="absolute top-1/2 right-2.5 grid h-7 min-w-7 -translate-y-1/2 place-items-center px-1.5 font-mono text-[11px] text-dim hover:bg-hover hover:text-fg focus-visible:outline focus-visible:outline-accent"
            onClick={() => onToggleStack?.(tree.rootId)}
          >
            {tree.size} {tree.collapsed ? '▸' : '▾'}
          </button>
        )}
        {!queuedStack && !compact && eligible && (
          <button
            aria-label={`Settle task: ${task.title}`}
            title={deadline === undefined ? 'Settle task' : `Settle now. Automatically settles ${new Date(deadline).toLocaleString()}.`}
            className="absolute top-1/2 right-2.5 grid size-7 -translate-y-1/2 place-items-center text-dim bg-overlay opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-fg hover:bg-hover focus-visible:outline focus-visible:outline-accent disabled:opacity-50"
            disabled={settling}
            onClick={() => void settle()}
          >
            <Icon icon="archive" size={16} aria-hidden="true" />
          </button>
        )}
        {error && <p role="alert" className="px-4 pb-2 text-xs text-danger" style={{ paddingLeft: indent }}>{error}</p>}
        {!queuedStack && !compact && hasChildren && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={`subtasks-${task.id}`}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} subtasks: ${task.title}`}
            className="flex w-full items-center justify-between gap-2 py-1 pr-4 font-mono text-[11px] text-faint hover:bg-white/5 hover:text-fg focus-visible:outline focus-visible:outline-accent"
            style={{ paddingLeft: indent }}
            onClick={toggleExpanded}
          >
            <span>{childCount} {childCount === 1 ? 'subtask' : 'subtasks'}</span>
            <Icon icon="chevron-down" size={14} className={cn('transition-transform', expanded && 'rotate-180')} aria-hidden="true" />
          </button>
        )}
      </article>
      {!queuedStack && hasChildren && showChildren && <ol id={`subtasks-${task.id}`} aria-label={`Subtasks of ${task.title}`} className="mr-4 mt-0.5 mb-2 border-l border-line pl-2 space-y-0.5" style={{ marginLeft: indent }}>
        {snapshot?.children.map((issue) => <li key={issue.id}>
          <div
            className="flex w-full min-w-0 items-center gap-2 min-h-7 px-2 py-1 text-left font-mono text-[11px] text-dim"
            title={issue.title}
          >
            <span className="min-w-0 flex-1 truncate">{issue.title}</span>
          </div>
        </li>)}
      </ol>}
    </li>
  )
}

const MAX_STACK_DEPTH = 3
const STACK_LEVEL = 32
const AUTO_DASH = 'color-mix(in srgb, var(--color-ember-400) 60%, transparent) 0 3px, transparent 3px 6px'

const branchWidth = (depth: number): number => 22 + (depth - 1) * STACK_LEVEL
const railX = (level: number): number => 8 + (level - 1) * STACK_LEVEL

function stackLine(origin: TaskStackOrigin, vertical: boolean): { className: string; style?: CSSProperties } {
  if (origin === 'manual') return { className: 'bg-line-strong' }
  return { className: '', style: { backgroundImage: `repeating-linear-gradient(${vertical ? 'to bottom' : 'to right'}, ${AUTO_DASH})` } }
}

function StackBranch({ tree, depth, width, tight }: { tree: SidebarStackTree; depth: number; width: number; tight: boolean }): JSX.Element {
  const lines: { key: string; origin: TaskStackOrigin; vertical: boolean; style: CSSProperties }[] = []
  tree.rails.slice(0, depth - 1).forEach((rail, index) => {
    if (rail) lines.push({ key: `rail-${index}`, origin: rail, vertical: true, style: { left: railX(index + 1), top: 0, height: '100vh' } })
  })
  const x = railX(depth)
  const origin = tree.origin ?? 'manual'
  lines.push({ key: 'up', origin, vertical: true, style: { left: x, top: 0, height: '50%' } })
  lines.push({ key: 'across', origin, vertical: false, style: { left: x, top: '50%', width: width + 4 - x, height: 1 } })
  if (tree.next) lines.push({ key: 'down', origin: tree.next, vertical: true, style: { left: x, top: '50%', height: '100vh' } })
  return (
    <span aria-hidden="true" className={cn('relative self-stretch', tight ? '-my-2' : '-my-2.5')}>
      {lines.map((line) => {
        const look = stackLine(line.origin, line.vertical)
        return <span key={line.key} className={cn('absolute', line.vertical && 'w-px', look.className)} style={{ ...line.style, ...look.style }} />
      })}
    </span>
  )
}

function StackStem({ origin, tight, children }: { origin: TaskStackOrigin; tight: boolean; children: ReactNode }): JSX.Element {
  const look = stackLine(origin, true)
  return (
    <span className={cn('relative grid place-items-center self-stretch', tight ? '-my-2' : '-my-2.5')}>
      <span aria-hidden="true" className={cn('absolute top-[calc(50%+9px)] left-1/2 h-[100vh] w-px -translate-x-1/2', look.className)} style={look.style} />
      {children}
    </span>
  )
}
