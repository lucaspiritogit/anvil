import type { ComponentPropsWithRef, JSX } from 'react'
import { useState } from 'react'
import { Icon } from '../icons'
import type { Project, Task, TaskIssueSnapshot } from '@shared/types'
import { issuePresentation, taskIssuePresentation } from '@shared/task-issue-presentation'
import { canSettleTask, settlementDeadline } from '@shared/task-settlement'
import { useStore } from '../state/store'
import { cn, ISSUE_STATUS } from '../ui'
import { openTaskContextMenu } from './TaskContextMenu'

const TASK_INDICATORS = {
  queued: { icon: 'loader', label: 'Queued', tone: 'text-accent', highlight: '' },
  running: { icon: 'loader', label: 'Working', tone: 'text-accent', highlight: '' },
  saving: { icon: 'loader', label: 'Saving changes…', tone: 'text-accent', highlight: '' },
  done: { icon: 'check', label: 'Done', tone: 'text-ok', highlight: '' },
  approved: { icon: 'check', label: 'Approved', tone: 'text-ok', highlight: 'bg-ok/8 hover:bg-ok/12 ring-ok/30' },
  reviewable: { icon: 'bell-ring', label: 'Ready for review', tone: 'text-orange-400', highlight: 'bg-orange-400/8 hover:bg-orange-400/12 ring-orange-400/30' },
  failed: { icon: 'x', label: 'Failed', tone: 'text-danger', highlight: '' }
} as const

function taskIndicator(task: Task): typeof TASK_INDICATORS[keyof typeof TASK_INDICATORS] | undefined {
  if (task.deliveryStatus === 'finalizing' || task.deliveryStatus === 'did_not_commit') return TASK_INDICATORS.saving
  if (task.status === 'pending') return TASK_INDICATORS.queued
  if (task.status === 'running') return TASK_INDICATORS.running
  if (task.status === 'failed' || task.deliveryStatus === 'failed' || task.deliveryStatus === 'agent_failed') {
    return TASK_INDICATORS.failed
  }
  if (task.status === 'succeeded') {
    if (task.deliveryStatus === 'no_changes') return TASK_INDICATORS.done
    if (task.deliveryStatus === 'approved') return TASK_INDICATORS.approved
    if (task.deliveryStatus === 'reviewable') return TASK_INDICATORS.reviewable
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
        ...(presentation.issue.reviewedAt != null ? TASK_INDICATORS.approved : TASK_INDICATORS.done),
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

export function SidebarTask({ task, snapshot, project, now, active, compact = false, rowProps }: {
  task: Task
  snapshot?: TaskIssueSnapshot | null
  project?: Project
  now: number
  active: boolean
  compact?: boolean
  rowProps?: ComponentPropsWithRef<'li'> & { 'data-index'?: number }
}): JSX.Element {
  const parent = useStore((state) => state.tasks.find((entry) => entry.id === (task.restackTarget?.parentTaskId ?? task.parentTaskId)))
  const openTask = useStore((state) => state.openTask)
  const settleTask = useStore((state) => state.settleTask)
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
  const hasChildren = childCount > 0
  const showChildren = compact || expanded
  const eligible = canSettleTask(task)
  const deadline = settlementDeadline(task)
  const presentation = taskIssuePresentation(task, snapshot)
  const indicator = presentation ? taskIssueIndicator(presentation) : taskIndicator(task)
  const statusIcon = (
    <span role={indicator ? 'img' : undefined} aria-label={indicator?.label} title={indicator?.label} className={cn('flex shrink-0', indicator?.tone ?? 'text-dim')}>
      <Icon
        icon={indicator?.icon ?? 'folder'}
        size={compact ? 15 : 16}
        className={indicator?.icon === 'loader' ? 'animate-spin motion-reduce:animate-none' : undefined}
        aria-hidden="true"
      />
    </span>
  )

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

  return (
    <li {...rowProps}>
      <article
        className={cn(
          'group relative transition-colors',
          parent && 'ml-3 border-l border-accent/40',
          indicator?.highlight || (active ? 'bg-hover' : compact ? 'hover:bg-hover/60' : 'bg-raised/60 hover:bg-hover/70'),
          (active || indicator?.highlight) && 'ring-1 ring-inset',
          active && (indicator?.highlight ? 'outline outline-1 outline-offset-1 outline-dim/60' : 'ring-line')
        )}
      >
        <button
          aria-label={`Open task: ${task.title}`}
          aria-current={active ? 'page' : undefined}
          className={cn('w-full min-w-0 text-left focus-visible:outline focus-visible:outline-accent', compact ? 'flex items-center gap-2 px-2.5 py-2' : 'block px-3 py-3')}
          onClick={() => void openTask(task.id)}
          onContextMenu={(event) => openTaskContextMenu(event, task.id)}
          title={task.prompt}
        >
          {compact ? (
            <>
              {statusIcon}
              <span className="min-w-0 flex-1 truncate text-xs text-dim">{task.title}</span>
              <span className="shrink-0 text-[10px] text-dim/70">{relativeAge(task.settledAt ?? task.startedAt, now)}</span>
            </>
          ) : (
            <>
              <span className="flex items-center justify-between gap-2 mb-2 text-xs text-dim">
                <span className="flex min-w-0 items-center gap-2">
                  {statusIcon}
                  <span className="truncate">{project?.name ?? 'Project'}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  <span className={cn('shrink-0 text-[11px]', indicator?.tone, eligible && 'group-hover:invisible group-focus-within:invisible')}>
                    {indicator?.label ?? (task.status === 'pending' ? 'Pending' : task.status === 'cancelled' ? 'Cancelled' : relativeAge(task.endedAt ?? task.startedAt, now))}
                  </span>
                </span>
              </span>
              <span className={cn('block truncate text-[13px] font-medium', active || task.status === 'running' ? 'text-fg' : 'text-fg/80')}>
                {task.title}
              </span>
              <span className="block truncate mt-1 font-mono text-[10px] text-dim/65">
                {task.branchName ?? task.agentLabel}
              </span>
            </>
          )}
          {parent && <span className="block truncate text-[10px] text-dim">Stacked on {parent.title}</span>}
          {task.restackState && <span className="block text-[10px] text-warn">Restack {task.restackState}</span>}
          {presentation && <span className="block truncate px-1 text-[11px] text-dim" title={presentation.issue.title}>{presentation.label}: {presentation.issue.title}</span>}
        </button>
        {!compact && eligible && (
          <button
            aria-label={`Settle task: ${task.title}`}
            title={deadline === undefined ? 'Settle task' : `Settle now. Automatically settles ${new Date(deadline).toLocaleString()}.`}
            className="absolute top-2 right-2 grid size-7 place-items-center text-dim bg-raised opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:text-fg hover:bg-hover focus-visible:outline focus-visible:outline-accent disabled:opacity-50"
            disabled={settling}
            onClick={() => void settle()}
          >
            <Icon icon="archive" size={16} aria-hidden="true" />
          </button>
        )}
        {error && <p role="alert" className="px-3 pb-2 text-xs text-danger">{error}</p>}
        {!compact && hasChildren && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={`subtasks-${task.id}`}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} subtasks: ${task.title}`}
            className="flex w-full items-center justify-between gap-2 border-t border-line px-3 py-1.5 text-xs text-dim hover:bg-white/5 hover:text-fg focus-visible:outline focus-visible:outline-accent"
            onClick={toggleExpanded}
          >
            <span>{childCount} {childCount === 1 ? 'subtask' : 'subtasks'}</span>
            <Icon icon="chevron-down" size={20} className={cn('transition-transform', expanded && 'rotate-180')} aria-hidden="true" />
          </button>
        )}
      </article>
      {hasChildren && showChildren && <ol id={`subtasks-${task.id}`} aria-label={`Subtasks of ${task.title}`} className="ml-4 mr-2 mt-1 mb-2 border-l border-line pl-2 space-y-1">
        {snapshot?.children.map((issue) => <li key={issue.id}>
          <div
            className="flex w-full min-w-0 items-center gap-2 min-h-7 px-2 py-1 text-left text-[11px] text-dim"
            title={issue.title}
          >
            <span className="min-w-0 flex-1 truncate">{issue.title}</span>
            <span className={cn('shrink-0 text-[10px]', ISSUE_STATUS[issuePresentation(issue, snapshot, task).status].tone)}>{issuePresentation(issue, snapshot, task).label}</span>
          </div>
        </li>)}
      </ol>}
    </li>
  )
}
