import { issueIsReviewReady, taskIssuePresentation } from '@anvil/protocol/task-issue-presentation'
import type { JSX, ReactNode, RefObject } from 'react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons'
import { formatCost, formatDuration, formatTokens, tokenBreakdown } from '../format'
import { TaskStackStatus } from './TaskStackStatus'
import { useStore, type TaskPanel } from '../state/store'
import { useModelLabel } from '../state/agent-models'
import { btn, cn, deliveryTone, dot, field, ISSUE_STATUS, statusTone } from '../ui'
import { AgentIcon } from './AgentIcon'
import { OpenPullRequestModal } from './OpenPullRequestModal'
import { CopyableText } from './CopyableText'
import { TaskSteeringComposer } from './TaskSteeringComposer'
import { TaskIssues } from './TaskIssues'
import { useTaskIssues } from '../hooks/use-task-issues'
import { TaskOutput } from './TaskOutput'
import { ShipButton } from './ShipButton'
import { ShipChecks } from './ShipChecks'
import { RiskFlags } from './RiskFlags'
import type { DiffLineAnnotation } from '@pierre/diffs/react'
import type { DiffThemes } from '@anvil/protocol/diff-themes'
import { DEFAULT_DIFF_THEMES } from '@anvil/protocol/diff-themes'
import { isTaskSettled } from '@anvil/protocol/task-settlement'
import type {
  DeliveryStatus,
  Task,
  TaskComment,
  TaskStatus
} from '@anvil/protocol/types'
import { hasRunningTaskDiff, isLocalTask } from '@anvil/protocol/task-checkout'

interface Props {
  task: Task
  initialPanel?: TaskPanel
}

/** Either a saved note or the line currently being written on. */
type NoteMetadata = { comment: TaskComment; draft?: undefined } | { comment?: undefined; draft: CommentDraft }

interface CommentDraft {
  file: string
  side: TaskComment['side']
  lineNumber: number
}

interface PatchFilesProps {
  patch: string
  comments: TaskComment[]
  draft: CommentDraft | null
  themes: DiffThemes
  trailing?: ReactNode
  onSelectLine: (draft: CommentDraft | null) => void
  onSubmit: (draft: CommentDraft, body: string) => void
  onRemove: (id: string) => void
}

/** The note and its composer share a card that hangs off a coloured spine. */
const NOTE_CARD = 'px-3 py-2.5 my-1.5 bg-raised border-l-2'
const EMPTY_PANEL = 'grid flex-1 place-content-center gap-2 p-6 text-center text-sm text-dim'

const PatchFiles = lazy(async () => {
  const [{ FileDiff }, { parsePatchFiles }] = await Promise.all([
    import('@pierre/diffs/react'),
    import('@pierre/diffs')
  ])

  return {
    default: function PatchFiles({
      patch,
      comments,
      draft,
      themes,
      trailing,
      onSelectLine,
      onSubmit,
      onRemove
    }: PatchFilesProps): JSX.Element {
      const files = useMemo(
        () => parsePatchFiles(patch).flatMap((parsed) => parsed.files),
        [patch]
      )
      const [viewed, setViewed] = useState<Set<string>>(() => new Set())
      const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
      const viewedCount = files.filter((file) => viewed.has(file.name)).length

      const toggleCollapsed = (name: string): void => {
        setCollapsed((previous) => {
          const next = new Set(previous)
          if (next.has(name)) next.delete(name)
          else next.add(name)
          return next
        })
      }

      const markViewed = (name: string, checked: boolean): void => {
        setViewed((previous) => {
          const next = new Set(previous)
          if (checked) next.add(name)
          else next.delete(name)
          return next
        })
        setCollapsed((previous) => {
          const next = new Set(previous)
          if (checked) next.add(name)
          else next.delete(name)
          return next
        })
      }

      const annotationsFor = (name: string): DiffLineAnnotation<NoteMetadata>[] => [
        ...comments
          .filter((comment) => comment.file === name)
          .map((comment) => ({
            side: comment.side,
            lineNumber: comment.lineNumber,
            metadata: { comment }
          })),
        ...(draft && draft.file === name
          ? [{ side: draft.side, lineNumber: draft.lineNumber, metadata: { draft } }]
          : [])
      ]

      if (files.length === 0) return <p className="p-5 text-sm text-dim">No file changes in this range.</p>
      return (
        <div className="flex flex-1 flex-col min-h-0 min-w-0">
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 border-b border-line text-xs text-dim">
            {trailing}
            <span className="ml-auto tabular-nums">{viewedCount} of {files.length} viewed</span>
          </div>
          <div data-diff-scroller className="flex-1 min-h-0 overflow-auto overscroll-contain">
            {files.map((file) => {
              const isCollapsed = collapsed.has(file.name)
              return (
                <section key={file.name} aria-label={file.name} data-diff-file={file.name} className="border-b border-line">
                  <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-raised px-4 py-1.5 text-xs">
                    <button
                      type="button"
                      aria-expanded={!isCollapsed}
                      title={isCollapsed ? 'Expand file' : 'Collapse file'}
                      className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:text-fg"
                      onClick={() => toggleCollapsed(file.name)}
                    >
                      <Icon icon="chevron-right" size={12} aria-hidden="true"
                        className={cn('shrink-0 text-dim transition-transform duration-150', !isCollapsed && 'rotate-90')} />
                      <span className={cn('min-w-0 truncate font-mono', viewed.has(file.name) && 'text-dim')}>{file.name}</span>
                    </button>
                    <label className="flex shrink-0 items-center gap-1.5 text-dim hover:text-fg">
                      <input
                        type="checkbox"
                        className="accent-accent"
                        checked={viewed.has(file.name)}
                        onChange={(event) => markViewed(file.name, event.target.checked)}
                      />
                      Viewed
                    </label>
                  </div>
                  {!isCollapsed && (
                    <FileDiff
                      fileDiff={file}
                      disableWorkerPool
                      lineAnnotations={annotationsFor(file.name)}
                      selectedLines={
                        draft && draft.file === file.name
                          ? { start: draft.lineNumber, end: draft.lineNumber, side: draft.side }
                          : null
                      }
                      renderAnnotation={({ metadata }) =>
                        metadata.comment ? (
                          <CommentNote comment={metadata.comment} onRemove={() => onRemove(metadata.comment.id)} />
                        ) : (
                          <CommentComposer onCancel={() => onSelectLine(null)} onSubmit={(body) => onSubmit(metadata.draft, body)} />
                        )
                      }
                      options={{
                        theme: themes,
                        themeType: 'system',
                        diffStyle: 'unified',
                        overflow: 'wrap',
                        disableFileHeader: true,
                        enableLineSelection: true,
                        onLineSelectionEnd(range) {
                          if (range === null) return
                          onSelectLine({
                            file: file.name,
                            side: range.side === 'deletions' ? 'deletions' : 'additions',
                            lineNumber: range.end
                          })
                        }
                      }}
                    />
                  )}
                </section>
              )
            })}
          </div>
        </div>
      )
    }
  }
})

function CommentNote({
  comment,
  onRemove
}: {
  comment: TaskComment
  onRemove: () => void
}): JSX.Element {
  return (
    <div
      className={cn(
        NOTE_CARD,
        'flex gap-3 items-start justify-between',
        comment.sentAt === null ? 'border-l-accent' : 'border-l-dim opacity-70'
      )}
    >
      <p className="text-[13px] whitespace-pre-wrap">{comment.body}</p>
      {comment.sentAt === null ? (
        <button className={btn.text} onClick={onRemove}>
          Remove
        </button>
      ) : (
        <span className="flex-none text-[11px] text-dim">Sent</span>
      )}
    </div>
  )
}

function CommentComposer({
  onCancel,
  onSubmit
}: {
  onCancel: () => void
  onSubmit: (body: string) => void
}): JSX.Element {
  const [body, setBody] = useState('')
  return (
    <div className={cn(NOTE_CARD, 'border-l-warn')}>
      <textarea
        className={field.textarea}
        autoFocus
        rows={3}
        value={body}
        placeholder="Leave a note on this line…"
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) onSubmit(body)
        }}
      />
      <div className="flex gap-2 justify-end mt-2">
        <button className={btn.ghost} onClick={onCancel}>
          Cancel
        </button>
        <button className={btn.primary} disabled={!body.trim()} onClick={() => onSubmit(body)}>
          Add comment
        </button>
      </div>
    </div>
  )
}

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  succeeded: 'Succeeded',
  failed: 'Failed',
  cancelled: 'Cancelled'
}

const DELIVERY_LABEL: Record<DeliveryStatus, string> = {
  preparing: 'Preparing branch',
  working: 'Branch active',
  finalizing: 'Branch active',
  did_not_commit: 'Branch active',
  reviewable: 'Ready to ship',
  merge_conflict: 'Merge conflicts with target branch',
  approved: 'Shipped',
  no_changes: 'No code changes',
  agent_failed: 'Nothing to ship',
  failed: 'Delivery failed',
  unavailable: 'Not tracked by Git'
}

function StatBlock({ label, value, detail }: {
  label: string
  value: ReactNode
  detail?: string
}): JSX.Element {
  return (
    <div className="flex items-baseline gap-x-1.5 whitespace-nowrap" title={detail}>
      <span className="text-dim">{label}</span>
      <span className="font-medium tabular-nums text-fg">{value}</span>
    </div>
  )
}

function TaskDetails({ task, workspaceName, projectName, projectPath, now, mobile = false }: {
  task: Task
  workspaceName: string
  projectName: string
  projectPath?: string
  now: number
  mobile?: boolean
}): JSX.Element {
  const modelLabel = useModelLabel(task.agentId, task.model)
  return (
    <div className={mobile ? 'grid gap-3 pt-2' : 'flex flex-wrap items-center justify-between gap-x-5 gap-y-1'}>
      <div className={mobile ? 'grid min-w-0 gap-2' : 'flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1'}>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate" title={workspaceName} aria-label="Task workspace">{workspaceName}</span>
          <span aria-hidden="true">/</span>
          <span className="truncate" title={projectPath}>{projectName}</span>
        </span>
        <span className={cn('flex items-center gap-1.5', mobile && 'min-w-0')}>
          <AgentIcon agentId={task.agentId} label={task.agentLabel} size={14} />
          <span className={mobile ? 'shrink-0' : undefined}>{task.agentLabel}</span>
          {modelLabel && <span className={mobile ? 'min-w-0 break-all' : '[overflow-wrap:anywhere]'} title={task.model}>· {modelLabel}</span>}
        </span>
        {task.branchName && (
          <span className="flex min-w-0 items-center gap-1.5">
            {task.baseBranch && <span className="min-w-0 truncate" title={task.baseBranch}>{task.baseBranch} ←</span>}
            <CopyableText label="branch name" value={task.branchName} />
          </span>
        )}
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="shrink-0">ID</span>
          <CopyableText label="task ID" value={task.id} />
        </span>
      </div>
      <div aria-label="Task statistics" role="group" className={mobile
        ? 'grid grid-cols-2 gap-x-3 gap-y-2 border-t border-line pt-2'
        : 'flex flex-wrap items-center gap-x-4 gap-y-1'}>
        <StatBlock label="Elapsed" value={formatDuration(task, now)} />
        <StatBlock label="Tokens" detail={tokenBreakdown(task)} value={
          <span className="flex gap-x-1.5">
            <span>{formatTokens(task.inputTokens)} <span className="text-dim">in</span></span>
            <span className="text-dim">/</span>
            <span>{formatTokens(task.outputTokens)} <span className="text-dim">out</span></span>
          </span>
        } />
        <StatBlock label="Cached" value={formatTokens(task.cachedTokens)} detail={`${formatTokens(task.cachedTokens)} cached input`} />
        <StatBlock label="Cost" value={formatCost(task.costUsd)} />
      </div>
    </div>
  )
}

function Notice({ tone = 'danger', children }: { tone?: 'danger' | 'warn'; children: ReactNode }): JSX.Element {
  return (
    <div role="alert" className={cn('shrink-0 max-h-20 overflow-auto px-5 py-2 text-xs [overflow-wrap:anywhere]', tone === 'danger' ? 'text-danger bg-danger/8' : 'text-warn bg-warn/8')}>
      {children}
    </div>
  )
}

const WIDE_LAYOUT_PX = 1100
const CHANGES_PANE_KEY = 'anvil.changesPane'
const CHANGES_WIDTH_KEY = 'anvil.changesPaneWidth'

function readPreference(key: string): string | null {
  try { return window.localStorage.getItem(key) } catch { return null }
}

function writePreference(key: string, value: string): void {
  try { window.localStorage.setItem(key, value) } catch {}
}

function useWideLayout(ref: RefObject<HTMLElement | null>): boolean {
  const [wide, setWide] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const measure = (): void => setWide(element.getBoundingClientRect().width >= WIDE_LAYOUT_PX)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return wide
}

function ResizeHandle({ containerRef, width, onResize }: {
  containerRef: RefObject<HTMLElement | null>
  width: number
  onResize: (width: number) => void
}): JSX.Element {
  const clamp = (value: number): number => {
    const total = containerRef.current?.getBoundingClientRect().width ?? 0
    return Math.max(360, Math.min(value, total - 360))
  }
  return <div
    role="separator"
    aria-orientation="vertical"
    aria-label="Resize changes pane"
    tabIndex={0}
    className="w-1.5 shrink-0 cursor-col-resize bg-transparent hover:bg-accent/40 focus-visible:bg-accent/60 focus-visible:outline-none"
    onPointerDown={(event) => {
      const container = containerRef.current
      if (!container) return
      event.currentTarget.setPointerCapture(event.pointerId)
      const right = container.getBoundingClientRect().right
      const move = (moveEvent: PointerEvent): void => onResize(clamp(right - moveEvent.clientX))
      const up = (): void => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    }}
    onKeyDown={(event) => {
      const current = width || (containerRef.current?.getBoundingClientRect().width ?? 0) / 2
      if (event.key === 'ArrowLeft') onResize(clamp(current + 40))
      if (event.key === 'ArrowRight') onResize(clamp(current - 40))
    }}
  />
}

export function TaskView({ task, initialPanel = 'output' }: Props): JSX.Element {
  const worktree = !isLocalTask(task)
  const { snapshot } = useTaskIssues(task.id, worktree)
  const workspaceName = useStore((s) => s.workspaces.find((workspace) => workspace.id === task.workspaceId)?.name ?? task.workspaceId)
  const project = useStore((s) => s.projects.find((item) => item.id === task.projectId))
  const diff = useStore((s) => s.diffsByTask[task.id])
  const diffError = useStore((s) => s.diffErrorsByTask[task.id])
  const loadTaskDiff = useStore((s) => s.loadTaskDiff)

  const comments = useStore((s) => s.commentsByTask[task.id])
  const loadComments = useStore((s) => s.loadComments)
  const addComment = useStore((s) => s.addComment)
  const removeComment = useStore((s) => s.removeComment)
  const sending = useStore((s) => s.sendingComments === task.id)
  const commentError = useStore((s) => s.commentError)
  const [draft, setDraft] = useState<CommentDraft | null>(null)
  const settings = useStore((s) => s.settings)
  const supportsCompaction = useStore((s) => s.agents.find((agent) => agent.id === task.agentId)?.supportsCompaction)
  const [compacting, setCompacting] = useState(false)
  const [compactError, setCompactError] = useState('')
  const compactBusy = compacting || task.contextCompacting === true
  const compact = async (): Promise<void> => {
    setCompacting(true)
    setCompactError('')
    try { await window.anvil.tasks.compact(task.id) }
    catch (error) { setCompactError(error instanceof Error ? error.message : String(error)) }
    finally { setCompacting(false) }
  }
  const [pullRequestTaskId, setPullRequestTaskId] = useState<string | null>(null)
  const approved = task.deliveryStatus === 'approved'
  const openPullRequest = task.deliveryStatus === 'reviewable' ? task.pullRequest : undefined

  const [now, setNow] = useState(Date.now())
  const done = task.status === 'succeeded' && (task.deliveryStatus === 'no_changes' || !worktree)
  const reviewable = task.deliveryStatus === 'reviewable' || approved
  const previewing = !reviewable && hasRunningTaskDiff(task)
  const showsDiff = reviewable || previewing
  const finalDiffPending = task.status === 'running' || task.deliveryStatus === 'finalizing' || task.deliveryStatus === 'did_not_commit'
  const [activePanel, setActivePanel] = useState<TaskPanel>(initialPanel)
  const openChanges = useCallback(() => setActivePanel('changes'), [])
  const conflictId = task.deliveryStatus === 'merge_conflict' ? task.mergeConflict?.id : undefined

  useEffect(() => {
    if (conflictId) setActivePanel('output')
  }, [conflictId])

  useEffect(() => {
    setNow(Date.now())
    // The persisted interval closes during issue review even if status stays running.
    if (task.workingStartedAt === undefined) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [task.id, task.workingStartedAt])

  useEffect(() => {
    if (showsDiff && !diff && !diffError) void loadTaskDiff(task.id)
  }, [diff, diffError, loadTaskDiff, showsDiff, task.id, task.headCommit, task.baseCommit])

  useEffect(() => {
    if ((worktree || reviewable) && !comments) void loadComments(task.id)
  }, [comments, loadComments, reviewable, task.id, worktree])

  const pending = (comments ?? []).filter((comment) => comment.sentAt === null)
  // Submission is visible immediately, even while the turn is still stopping.
  const presentation = taskIssuePresentation(task, snapshot)

  const rootRef = useRef<HTMLDivElement>(null)
  const wide = useWideLayout(rootRef)
  const [paneHidden, setPaneHidden] = useState(() => readPreference(CHANGES_PANE_KEY) === 'hidden')
  const [paneWidth, setPaneWidth] = useState(() => Number(readPreference(CHANGES_WIDTH_KEY)) || 0)
  const split = wide && showsDiff && !paneHidden
  const panels: readonly TaskPanel[] = split
    ? worktree ? ['output', 'issues'] : ['output']
    : worktree ? ['output', 'changes', 'issues'] : ['output', 'changes']
  const visiblePanel = split && activePanel === 'changes' ? 'output' : activePanel
  const togglePane = (): void => {
    const next = !paneHidden
    setPaneHidden(next)
    writePreference(CHANGES_PANE_KEY, next ? 'hidden' : 'shown')
    if (!next && activePanel === 'changes') setActivePanel('output')
  }

  const changesSection = (
    <section id="task-panel-changes" aria-label="Code changes" className={cn('flex flex-col min-h-0 min-w-0 flex-1', !split && activePanel !== 'changes' && 'hidden')}>
      {showsDiff ? <>
        {previewing && <p className="shrink-0 border-b border-line px-5 py-2 text-xs text-dim">The agent is still working. Showing the latest recorded changes; this view updates when the turn ends.</p>}
        {!diff && !diffError && <p className="p-5 text-sm text-dim">Loading code changes…</p>}
        {diffError && <div role="alert" className="p-5 text-sm text-danger">
          <p>{diffError}</p>
          <button className={cn(btn.ghost, 'mt-3')} onClick={() => void loadTaskDiff(task.id)}>Retry</button>
        </div>}
        {diff && !approved && !previewing && <RiskFlags patch={diff.patch} expectedFiles={task.expectedFiles} />}
        {diff && <Suspense fallback={<p className="p-5 text-sm text-dim">Loading diff renderer…</p>}>
          <PatchFiles
            key={diff.patch}
            patch={diff.patch}
            comments={comments ?? []}
            draft={draft}
            themes={settings?.diffThemes ?? DEFAULT_DIFF_THEMES}
            trailing={<>
              {!approved && !previewing && <span>{pending.length ? `${pending.length} note${pending.length === 1 ? '' : 's'} waiting in the message box` : 'Select a line to leave a note for the agent'}</span>}
            </>}
            onSelectLine={approved || previewing ? () => {} : setDraft}
            onSubmit={(target, body) => {
              void addComment({ taskId: task.id, ...target, body })
              setDraft(null)
            }}
            onRemove={(id) => void removeComment(task.id, id)}
          />
        </Suspense>}
      </> : <div className={EMPTY_PANEL}>
        <p>{done ? 'Done' : finalDiffPending ? 'The agent is working on this task.' : DELIVERY_LABEL[task.deliveryStatus]}</p>
        <p className="text-xs">{done ? 'No code changes to ship.' : finalDiffPending ? 'The task diff will appear here when the agent finishes.' : 'There is no diff available to ship.'}</p>
      </div>}
    </section>
  )

  return (
    <div ref={rootRef} className="@container relative flex flex-col h-full min-w-0 min-h-0 overflow-hidden">
      {pullRequestTaskId === task.id && (
        <OpenPullRequestModal key={task.id} task={task} onClose={() => setPullRequestTaskId(null)} />
      )}
      <TaskStackStatus key={`stack-${task.id}`} task={task} />
      <header className="shrink-0 px-5 pt-3 pb-2 @max-[760px]:px-4 @max-[760px]:pt-2">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 @max-[760px]:flex-col">
          <div className="flex min-w-0 flex-1 items-center gap-2 @max-[760px]:w-full @max-[760px]:flex-none">
            <h1 className="min-w-0 truncate font-mono text-[15px] font-semibold leading-snug tracking-[-0.01em]" title={task.title}>{task.title}</h1>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 text-xs @max-[760px]:w-full @max-[760px]:min-w-0 @max-[760px]:justify-start">
            <span aria-label="Task status" className="flex min-w-0 flex-wrap items-center gap-2">
              {presentation ? <span className={ISSUE_STATUS[presentation.status].tone}>{presentation.label}: {presentation.issue.title}</span> : <>
              <span className={dot(task.status)} />
              <span className={cn('font-medium', statusTone(task.status))}>{done ? 'Done' : STATUS_LABEL[task.status]}</span>
              {worktree && <><span className="text-dim">·</span>
              <span className={cn('flex items-center gap-1.5', openPullRequest ? 'text-ok' : deliveryTone(task.deliveryStatus))}>
                {openPullRequest && <Icon icon="git-branch" size={14} aria-hidden="true" />}
                {openPullRequest
                  ? 'Open PR'
                  : task.deliveryStatus === 'merge_conflict' && task.mergeConflict
                    ? `Merge conflicts with ${task.mergeConflict.targetBranch}`
                    : DELIVERY_LABEL[task.deliveryStatus]}
              </span></>}
              </>}
            </span>
            {reviewable && <span className="relative ml-2 flex flex-wrap items-center gap-2 @max-[760px]:ml-0">
              {!approved && <ShipChecks task={task} />}
              <ShipButton
                task={task}
                disabled={!diff || sending || compactBusy || Boolean(task.parentTaskId || task.restackState)}
                disabledReason={task.restackState ? 'Finish restacking before shipping' : task.parentTaskId ? 'Ship the parent task first' : undefined}
                onOpenPullRequest={worktree && !approved ? () => setPullRequestTaskId(task.id) : undefined}
              />
            </span>}
          </div>
        </div>
        <div className="mt-1.5 font-mono text-[11.5px] text-dim @max-[760px]:hidden">
          <TaskDetails task={task} workspaceName={workspaceName} projectName={project?.name ?? 'No project'} projectPath={project?.path} now={now} />
        </div>
        <details className="group mt-1.5 hidden text-[11.5px] text-dim @max-[760px]:block">
          <summary className="flex w-fit cursor-pointer select-none list-none items-center gap-1 py-1 font-medium text-dim hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent [&::-webkit-details-marker]:hidden">
            Details
            <Icon icon="chevron-down" size={14} className="transition-transform group-open:rotate-180" aria-hidden="true" />
          </summary>
          <TaskDetails task={task} workspaceName={workspaceName} projectName={project?.name ?? 'No project'} projectPath={project?.path} now={now} mobile />
        </details>
      </header>

      {(task.error || (task.restackState !== 'conflict' && task.deliveryError)) && <Notice>{task.error || task.deliveryError}</Notice>}
      {task.contextCompactionError && <Notice>{task.contextCompactionError}</Notice>}
      {reviewable && commentError && <Notice>{commentError}</Notice>}

      <div className="flex flex-1 min-h-0 min-w-0">
      <div className="flex flex-1 min-h-0 min-w-0 flex-col">
      <div className="flex min-w-0 shrink-0 items-stretch gap-1 border-b border-line px-3 @max-[760px]:gap-0 @max-[760px]:px-2" role="tablist" aria-label="Task panels">
        {panels.map((panel) => {
          const selected = visiblePanel === panel
          return (
            <button
              key={panel}
              role="tab"
              id={`task-tab-${panel}`}
              aria-controls={`task-panel-${panel}`}
              aria-selected={selected}
              className={cn(
                'relative flex min-w-0 items-center gap-1.5 px-3 py-2.5 text-[13px] font-medium focus-visible:outline focus-visible:outline-accent @max-[760px]:flex-1 @max-[760px]:justify-center @max-[760px]:gap-1 @max-[760px]:px-1',
                selected ? 'text-fg' : 'text-dim hover:text-fg'
              )}
              onClick={() => setActivePanel(panel)}
            >
              {selected && <span aria-hidden="true" className="absolute inset-x-0 -bottom-px h-0.5 bg-accent" />}
              {panel === 'output' && 'Output'}
              {panel === 'issues' && 'Issues'}
              {panel === 'changes' && <>
                Changes{' '}
                <span className="font-mono text-[11px] font-normal tabular-nums text-faint">{showsDiff && !diff ? 'Loading…' : task.filesChanged}</span>
                {(!showsDiff || diff) && task.filesChanged > 0 && <>{' '}<span className="font-mono text-[11px] font-normal tabular-nums">
                  <span className="text-ok">+{task.additions}</span> <span className="text-danger">−{task.deletions}</span>
                </span></>}
              </>}
            </button>
          )
        })}
        {wide && showsDiff && <button
          type="button"
          className="ml-auto flex items-center gap-1.5 self-center px-2 py-1 font-mono text-[11px] text-dim hover:bg-hover hover:text-fg focus-visible:outline-2 focus-visible:outline-accent"
          aria-pressed={split}
          title={split ? 'Show changes as a tab' : 'Show changes beside the output'}
          onClick={togglePane}
        >
          <Icon icon={split ? 'arrow-right-to-line' : 'arrow-left-to-line'} size={13} aria-hidden="true" />
          {split ? 'Hide changes' : 'Changes beside output'}
        </button>}
      </div>

      <div className="flex flex-1 min-h-0 min-w-0">
        {worktree && <TaskIssues taskId={task.id} active={visiblePanel === 'issues'} />}

        {!split && changesSection}

        <TaskOutput key={task.id} task={task} visible={visiblePanel === 'output'} presentation={presentation} onOpenChanges={openChanges} />
      </div>

      {!isTaskSettled(task) && <TaskSteeringComposer
        key={`composer-${task.id}`}
        task={task}
        notes={pending}
        onRemoveNote={(id) => void removeComment(task.id, id)}
        onSent={() => void loadComments(task.id)}
        contextControl={{
          compactVisible: Boolean(supportsCompaction && task.sessionId),
          busy: compactBusy,
          disabled: task.status === 'running' && !issueIsReviewReady(snapshot) || compactBusy || task.deliveryStatus === 'finalizing',
          error: compactError,
          contextUsed: task.contextUsed,
          contextSize: task.contextSize,
          warningThreshold: settings?.contextCompactionThreshold,
          danger: Boolean(task.contextCompactionError || /context[._ ]window|context window|context length/i.test(task.error ?? '')),
          onCompact: () => void compact()
        }}
      />}
      </div>
      {split && <>
        <ResizeHandle containerRef={rootRef} width={paneWidth} onResize={(width) => {
          setPaneWidth(width)
          writePreference(CHANGES_WIDTH_KEY, String(Math.round(width)))
        }} />
        <aside aria-label="Changes pane" className="flex min-h-0 min-w-0 shrink-0 flex-col border-l border-line"
          style={{ width: paneWidth ? `${paneWidth}px` : '50%', maxWidth: 'calc(100% - 360px)', minWidth: 360 }}>
          {changesSection}
        </aside>
      </>}
      </div>
    </div>
  )
}
