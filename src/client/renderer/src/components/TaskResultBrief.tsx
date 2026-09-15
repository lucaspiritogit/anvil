import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import type { Project, TaskResultNotice, TaskResultNoticeKind } from '@shared/types'
import { Icon } from '../icons'
import { useStore } from '../state/store'
import { btn, cn } from '../ui'

interface Props {
  project: Project
}

const OUTCOME: Record<TaskResultNoticeKind, string> = {
  reviewable: 'Changes are ready for review',
  no_changes: 'Finished with no code changes',
  completed: 'Task completed'
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

function ResultRow({ notice }: { notice: TaskResultNotice }): JSX.Element {
  const task = useStore((state) => state.tasks.find((item) => item.id === notice.taskId))
  const openTask = useStore((state) => state.openTask)
  const markSeen = useStore((state) => state.markTaskResultNoticeSeen)
  const dismiss = useStore((state) => state.dismissTaskResultNotice)
  const [dismissing, setDismissing] = useState(false)
  const title = task?.title ?? 'Deleted task'
  const informational = notice.kind !== 'reviewable' || !task

  const open = (): void => {
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
      className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-4 py-3 max-[700px]:items-start max-[700px]:px-3"
      data-notice-id={notice.id}
    >
      <div className="min-w-0 flex-1 basis-[360px]">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <strong className="min-w-0 truncate text-[13px] font-medium text-fg" title={title}>{title}</strong>
          {notice.seenAt !== undefined && <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-dim">Seen</span>}
        </div>
        <p className="mt-0.5 text-xs leading-relaxed text-dim">
          <span>{OUTCOME[notice.kind]}</span>
          <span aria-hidden="true"> · </span>
          <time dateTime={new Date(notice.createdAt).toISOString()} title={new Date(notice.createdAt).toLocaleString()}>
            {relativeTime(notice.createdAt)}
          </time>
        </p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 max-[700px]:w-full">
        <button
          type="button"
          className={cn(btn.ghost, 'max-[700px]:flex-1')}
          aria-label={task
            ? `${notice.kind === 'reviewable' ? 'Review changes for' : 'Open task'}: ${title}`
            : `Acknowledge result for deleted task`}
          onClick={open}
        >
          {task ? notice.kind === 'reviewable' ? 'Review changes' : 'Open task' : 'Acknowledge'}
        </button>
        {informational && task && (
          <button
            type="button"
            className={cn(btn.text, 'px-2 py-2 text-dim hover:text-fg disabled:opacity-45')}
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
  const error = useStore((state) => state.taskResultNoticeError)
  const projectNotices = notices.filter((notice) => notice.workspaceId === workspaceId && notice.projectId === project.id)
  const active = projectNotices.filter((notice) => notice.dismissedAt === undefined)
  const context = `${workspaceId ?? ''}:${project.id}`
  const unseenIds = active.filter((notice) => notice.seenAt === undefined).map((notice) => notice.id)
  const activeSignature = active.map((notice) => `${notice.id}:${notice.seenAt ?? ''}:${notice.dismissedAt ?? ''}`).join('|')
  const unseenSignature = unseenIds.join('|')
  const previousContext = useRef(context)
  const previousUnseen = useRef(new Set(unseenIds))
  const [expanded, setExpanded] = useState(active.length > 0)

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
        className="mb-4 flex min-w-0 items-center gap-3 border border-line bg-raised/85 px-4 py-2.5 max-[700px]:mb-3 max-[700px]:px-3"
      >
        <Icon icon="check" size={16} className="shrink-0 text-ok" />
        <p className="min-w-0 flex-1 text-xs text-dim"><span className="font-medium text-fg">Good morning.</span> You’re all caught up.</p>
        <button type="button" className={cn(btn.text, 'shrink-0')} aria-expanded="false" onClick={() => setExpanded(true)}>Expand</button>
      </section>
    )
  }

  return (
    <section aria-label="Morning task results" className="mb-5 min-w-0 border border-line bg-raised/90 max-[700px]:mb-3">
      <div className="flex min-w-0 items-center gap-3 px-4 py-3 max-[700px]:px-3">
        <Icon icon="coffee" size={18} className="shrink-0 text-warn" />
        <h2 className="min-w-0 flex-1 text-sm font-semibold">Good morning</h2>
        {active.length === 0 && (
          <button type="button" className={btn.text} aria-expanded="true" onClick={() => setExpanded(false)}>Collapse</button>
        )}
      </div>
      <div className="border-t border-line px-4 py-2.5 text-xs text-dim max-[700px]:px-3" aria-live="polite">
        <p><span className="font-medium text-fg">Since you left…</span>{' '}{active.length === 0
          ? 'You’re all caught up.'
          : `${active.length} task result${active.length === 1 ? '' : 's'} ${active.length === 1 ? 'is' : 'are'} ready.`}</p>
      </div>
      {active.map((notice) => <ResultRow key={notice.id} notice={notice} />)}
      {error?.workspaceId === workspaceId && error.projectId === project.id && (
        <p role="alert" className="border-t border-line px-4 py-2.5 text-xs text-danger max-[700px]:px-3">{error.message}</p>
      )}
    </section>
  )
}
