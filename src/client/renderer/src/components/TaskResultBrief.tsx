import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { Project, Task, TaskResultNotice, TaskResultNoticeKind } from '@shared/types'
import { Icon } from '../icons'
import { useStore } from '../state/store'
import { btn, cn } from '../ui'

interface Props {
  project: Project
}

type RowTone = 'warning' | 'success' | 'muted'
type ActionTone = 'warning' | 'accent' | 'muted'

interface PreviewResult {
  id: string
  title: string
  detail: string
  noticeKind: TaskResultNoticeKind
  taskKind?: TaskResultNoticeKind
  actionLabel: string
  rowTone: RowTone
  actionTone: ActionTone
  disabled?: boolean
}

interface PreviewNotice extends TaskResultNotice {
  previewResult: PreviewResult
}

interface PreviewActions {
  result: PreviewResult
  open: (notice: TaskResultNotice, task?: Task) => void
}

const OUTCOME: Record<TaskResultNoticeKind, string> = {
  reviewable: 'Ready for review',
  no_changes: 'No changes needed',
  completed: 'Task completed'
}

const PREVIEW_RESULTS: PreviewResult[] = [
  {
    id: 'decision',
    title: 'Migration compatibility',
    detail: 'Needs your input · Blocking 2 queued tasks',
    noticeKind: 'completed',
    actionLabel: 'View decision',
    rowTone: 'warning',
    actionTone: 'warning'
  },
  {
    id: 'review',
    title: 'Session refresh handling',
    detail: 'Ready for review · 4 files · 18 checks passed',
    noticeKind: 'reviewable',
    taskKind: 'reviewable',
    actionLabel: 'Review changes',
    rowTone: 'success',
    actionTone: 'accent'
  },
  {
    id: 'reviewed',
    title: 'Settings empty state',
    detail: 'Ready for review · 2 files · Checks not run',
    noticeKind: 'reviewable',
    actionLabel: 'Review changes',
    rowTone: 'success',
    actionTone: 'muted',
    disabled: true
  },
  {
    id: 'findings',
    title: 'Audit retry handling',
    detail: 'No changes needed · View the findings',
    noticeKind: 'no_changes',
    taskKind: 'no_changes',
    actionLabel: 'View findings',
    rowTone: 'muted',
    actionTone: 'muted'
  }
]

const STATUS_TONE: Record<RowTone, string> = {
  warning: 'border-warn text-warn',
  success: 'border-ok text-ok',
  muted: 'border-dim text-dim'
}

const ACTION_TONE: Record<ActionTone, string> = {
  warning: 'border-warn/60 text-warn enabled:hover:bg-warn/8',
  accent: 'border-accent/65 text-accent enabled:hover:bg-accent/8',
  muted: 'border-line text-dim enabled:hover:border-dim enabled:hover:text-fg'
}

function matchesPreviewResult(task: Task, kind: TaskResultNoticeKind): boolean {
  if (kind === 'reviewable') return task.deliveryStatus === 'reviewable'
  if (kind === 'no_changes') return task.deliveryStatus === 'no_changes' || task.deliveryStatus === 'did_not_commit'
  return task.status === 'succeeded'
}

function createPreviewNotices(
  workspaceId: string,
  project: Project,
  tasks: Task[],
  createdAt: number,
  seenIds: Set<string>
): PreviewNotice[] {
  const usedTaskIds = new Set<string>()

  return PREVIEW_RESULTS.map((result, index) => {
    const taskKind = result.taskKind
    const task = taskKind
      ? tasks.find((candidate) =>
          candidate.workspaceId === workspaceId &&
          candidate.projectId === project.id &&
          !usedTaskIds.has(candidate.id) &&
          matchesPreviewResult(candidate, taskKind)
        )
      : undefined
    if (task) usedTaskIds.add(task.id)

    const id = `dev-morning-${workspaceId}-${project.id}-${result.id}`
    return {
      id,
      workspaceId,
      projectId: project.id,
      taskId: task?.id ?? `${id}-task`,
      resultVersion: index + 1,
      kind: result.noticeKind,
      createdAt: createdAt - (index + 1) * 60_000,
      ...(seenIds.has(id) ? { seenAt: createdAt } : {}),
      previewResult: task ? { ...result, title: task.title } : result
    }
  })
}

function relativeTime(timestamp: number, now = Date.now()): string {
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < 60_000) return 'Just now'
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

function briefTimestamp(timestamp: number, now = new Date()): string {
  const value = new Date(timestamp)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfValue = new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
  const day = startOfValue === startOfToday
    ? 'Today'
    : startOfValue === startOfToday - 86_400_000
      ? 'Yesterday'
      : value.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  return `${day}, ${value.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`
}

function taskDetail(notice: TaskResultNotice, task?: Task): string {
  const details = [OUTCOME[notice.kind]]
  if (task && task.filesChanged > 0) details.push(`${task.filesChanged} file${task.filesChanged === 1 ? '' : 's'}`)
  details.push(relativeTime(notice.createdAt))
  return details.join(' · ')
}

function StatusIcon({ tone }: { tone: RowTone }): JSX.Element {
  return (
    <span className={cn('grid size-9 shrink-0 place-items-center rounded-full border-2', STATUS_TONE[tone])}>
      {tone === 'warning'
        ? <span className="text-lg font-semibold leading-none">!</span>
        : <Icon icon="check" size={18} />}
    </span>
  )
}

function ResultRow({ notice, preview }: { notice: TaskResultNotice; preview?: PreviewActions }): JSX.Element {
  const task = useStore((state) => state.tasks.find((item) => item.id === notice.taskId))
  const openTask = useStore((state) => state.openTask)
  const markSeen = useStore((state) => state.markTaskResultNoticeSeen)
  const dismiss = useStore((state) => state.dismissTaskResultNotice)
  const [dismissing, setDismissing] = useState(false)
  const title = task?.title ?? preview?.result.title ?? 'Deleted task'
  const detail = preview?.result.detail ?? taskDetail(notice, task)
  const rowTone = preview?.result.rowTone ?? (notice.kind === 'no_changes' ? 'muted' : 'success')
  const actionTone = preview?.result.actionTone ?? (notice.kind === 'reviewable' ? 'accent' : 'muted')
  const actionLabel = preview?.result.actionLabel ?? (task
    ? notice.kind === 'reviewable' ? 'Review changes' : 'Open task'
    : 'Acknowledge')
  const informational = notice.kind !== 'reviewable' || !task
  const actionDisabled = preview?.result.disabled === true || preview !== undefined && notice.seenAt !== undefined

  const open = (): void => {
    if (preview) {
      preview.open(notice, task)
      return
    }
    if (!task) {
      void dismiss(notice.id)
      return
    }
    void markSeen(notice.id)
    void openTask(task.id, notice.kind === 'reviewable' ? 'changes' : undefined)
  }

  const acknowledge = async (): Promise<void> => {
    setDismissing(true)
    await dismiss(notice.id)
    setDismissing(false)
  }

  return (
    <div
      className="flex min-w-0 items-center gap-4 border-t border-line px-5 py-4 first:border-t-0 max-[700px]:flex-wrap max-[700px]:gap-3 max-[700px]:px-4"
      data-notice-id={notice.id}
    >
      <StatusIcon tone={rowTone} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <strong className="min-w-0 truncate text-sm font-medium text-fg" title={title}>{title}</strong>
          {!preview && notice.seenAt !== undefined && <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-dim">Seen</span>}
        </div>
        <p className="mt-1 truncate text-xs leading-relaxed text-dim" title={detail}>{detail}</p>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-3 max-[700px]:ml-[52px] max-[700px]:w-[calc(100%-52px)]">
        <button
          type="button"
          className={cn(
            'min-w-[132px] border px-4 py-2 text-xs font-medium disabled:cursor-default disabled:opacity-45 max-[700px]:flex-1',
            ACTION_TONE[actionTone]
          )}
          aria-label={`${actionLabel}: ${title}`}
          disabled={actionDisabled}
          onClick={open}
        >
          {actionLabel}
        </button>
        {!preview && informational && task && (
          <button
            type="button"
            className={cn(btn.text, 'px-1 py-2 text-dim hover:text-fg disabled:opacity-45')}
            aria-label={`Dismiss result for: ${title}`}
            disabled={dismissing}
            onClick={() => void acknowledge()}
          >
            {dismissing ? 'Dismissing…' : 'Dismiss'}
          </button>
        )}
      </div>
    </div>
  )
}

export function TaskResultBrief({ project }: Props): JSX.Element {
  const workspaceId = useStore((state) => state.activeWorkspaceId)
  const notices = useStore((state) => state.taskResultNotices)
  const tasks = useStore((state) => state.tasks)
  const error = useStore((state) => state.taskResultNoticeError)
  const openTask = useStore((state) => state.openTask)
  const previewCreatedAt = useRef(Date.now())
  const [previewSeenIds, setPreviewSeenIds] = useState<Set<string>>(() => new Set())
  const realProjectNotices = notices.filter((notice) => notice.workspaceId === workspaceId && notice.projectId === project.id)
  const showPreview = import.meta.env.DEV && realProjectNotices.length === 0 && workspaceId !== null
  const previewNotices = showPreview
    ? createPreviewNotices(workspaceId, project, tasks, previewCreatedAt.current, previewSeenIds)
    : []
  const projectNotices = showPreview ? previewNotices : realProjectNotices
  const active = projectNotices.filter((notice) => notice.dismissedAt === undefined)
  const runningTasks = tasks.filter((task) =>
    task.workspaceId === workspaceId && task.projectId === project.id && task.status === 'running'
  )
  const context = `${workspaceId ?? ''}:${project.id}`
  const unseenIds = active.filter((notice) => notice.seenAt === undefined).map((notice) => notice.id)
  const activeSignature = active.map((notice) => `${notice.id}:${notice.seenAt ?? ''}:${notice.dismissedAt ?? ''}`).join('|')
  const unseenSignature = unseenIds.join('|')
  const previousContext = useRef(context)
  const previousUnseen = useRef(new Set(unseenIds))
  const [expanded, setExpanded] = useState(active.length > 0)

  const openPreview = (notice: TaskResultNotice, task?: Task): void => {
    setPreviewSeenIds((current) => new Set(current).add(notice.id))
    if (task) void openTask(task.id, notice.kind === 'reviewable' ? 'changes' : undefined)
  }

  useEffect(() => {
    if (previousContext.current !== context) {
      previousContext.current = context
      previousUnseen.current = new Set(unseenIds)
      setExpanded(active.length > 0)
      return
    }
    if (active.length === 0) setExpanded(false)
    else if (unseenIds.some((id) => !previousUnseen.current.has(id))) setExpanded(true)
    previousUnseen.current = new Set(unseenIds)
  }, [active.length, activeSignature, context, unseenSignature])

  if (projectNotices.length === 0) return <></>

  if (!expanded) {
    return (
      <section
        aria-label="Morning task results"
        className="mb-5 flex min-w-0 items-center gap-3 border border-line bg-raised/85 px-5 py-3"
      >
        <Icon icon="check" size={16} className="shrink-0 text-ok" />
        <p className="min-w-0 flex-1 text-xs text-dim"><span className="font-medium text-fg">Good morning.</span> You’re all caught up.</p>
        <button type="button" className={cn(btn.text, 'shrink-0')} aria-expanded="false" onClick={() => setExpanded(true)}>Expand</button>
      </section>
    )
  }

  const completedCount = showPreview ? 3 : active.length
  const summary = showPreview
    ? '3 tasks finished while you were away. 1 needs your input.'
    : `${completedCount} task result${completedCount === 1 ? '' : 's'} ${completedCount === 1 ? 'is' : 'are'} ready.`
  const since = showPreview
    ? 'Yesterday, 10:42 PM'
    : briefTimestamp(active[active.length - 1]?.createdAt ?? Date.now())
  const runningCount = showPreview ? 1 : runningTasks.length
  const runningTitle = showPreview ? 'Search indexing' : runningTasks[0]?.title

  return (
    <section aria-label="Morning task results" className="mb-7 min-w-0">
      <div className="mb-7 max-[700px]:mb-5">
        <h2 className="text-[32px] font-medium leading-tight tracking-[-0.025em] text-fg max-[700px]:text-2xl">
          Good morning.
        </h2>
        <p className="mt-1.5 text-sm text-dim max-[700px]:text-xs">{summary}</p>
      </div>

      <div className="mb-2 flex items-center justify-between gap-4 text-[10px] font-semibold uppercase tracking-[0.18em] text-dim">
        <span>Since you left</span>
        <time className="font-normal normal-case tracking-normal" dateTime={new Date(active[active.length - 1]?.createdAt ?? Date.now()).toISOString()}>{since}</time>
      </div>

      <div className="border border-line bg-raised/90 shadow-[0_18px_55px_rgba(0,0,0,0.16)]">
        {active.map((notice) => (
          <ResultRow
            key={notice.id}
            notice={notice}
            preview={showPreview && 'previewResult' in notice
              ? { result: notice.previewResult as PreviewResult, open: openPreview }
              : undefined}
          />
        ))}
        {!showPreview && error?.workspaceId === workspaceId && error.projectId === project.id && (
          <p role="alert" className="border-t border-line px-5 py-3 text-xs text-danger">{error.message}</p>
        )}
      </div>

      {runningCount > 0 && runningTitle && (
        <div className="mt-3 flex min-w-0 items-center gap-2 text-xs text-dim">
          <Icon icon="loader" size={14} className="shrink-0 animate-spin" />
          <span>{runningCount} task{runningCount === 1 ? '' : 's'} still running</span>
          <span aria-hidden="true">·</span>
          <span className="truncate">{runningTitle}</span>
          <span aria-hidden="true">·</span>
          <span className="shrink-0">{showPreview ? 'Active 30s ago' : 'Active now'}</span>
        </div>
      )}
    </section>
  )
}
