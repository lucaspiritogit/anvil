import { issueIsReviewReady, issuePresentation, taskIssuePresentation } from '@shared/task-issue-presentation'
import type { JSX, ReactNode } from 'react'
import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../icons'
import { formatCost, formatDuration, formatTokens, tokenBreakdown } from '../format'
import { TaskStackStatus } from './TaskStackStatus'
import { useStore } from '../state/store'
import { btn, cn, deliveryTone, dot, field, ISSUE_STATUS, statusTone } from '../ui'
import { AgentIcon } from './AgentIcon'
import { AgentRebaseModal } from './AgentRebaseModal'
import { ApproveTaskModal } from './ApproveTaskModal'
import { OpenPullRequestModal } from './OpenPullRequestModal'
import { CopyableText } from './CopyableText'
import { RebaseModal } from './RebaseModal'
import { TaskSteeringComposer } from './TaskSteeringComposer'
import { TaskIssues } from './TaskIssues'
import { useTaskIssues } from '../hooks/use-task-issues'
import { TaskActivity } from './TaskActivity'
import type { DiffLineAnnotation } from '@pierre/diffs/react'
import { contextOccupancy } from '@shared/task-context'
import { isTaskSettled } from '@shared/task-settlement'
import type {
  DeliveryStatus,
  Task,
  TaskComment,
  TaskDiff,
  TaskEvent,
  TaskEventCategory,
  TaskStatus
} from '@shared/types'

interface Props {
  task: Task
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
  trailing?: ReactNode
  onSelectLine: (draft: CommentDraft | null) => void
  onSubmit: (draft: CommentDraft, body: string) => void
  onRemove: (id: string) => void
}

const PLACEHOLDER = 'mx-2 my-1 text-xs text-dim'
/** The note and its composer share a card that hangs off a coloured spine. */
const NOTE_CARD = 'px-3 py-2.5 my-1.5 bg-raised border-l-2'
const EMPTY_PANEL = 'grid flex-1 place-content-center gap-2 p-6 text-center text-sm text-dim'
const ICON_BTN = 'grid size-7 shrink-0 place-items-center text-dim hover:text-fg hover:bg-hover disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-dim'

type TaskPanel = 'output' | 'changes' | 'issues'

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
      trailing,
      onSelectLine,
      onSubmit,
      onRemove
    }: PatchFilesProps): JSX.Element {
      const files = useMemo(
        () => parsePatchFiles(patch).flatMap((parsed) => parsed.files),
        [patch]
      )
      const [selectedPath, setSelectedPath] = useState<string | null>(null)
      const [viewed, setViewed] = useState<Set<string>>(() => new Set())
      const selectedIndex = Math.max(0, files.findIndex((file) => file.name === selectedPath))
      const selectedFile = files[selectedIndex]
      const viewedCount = files.filter((file) => viewed.has(file.name)).length

      const selectFile = (path: string): void => {
        setSelectedPath(path)
        onSelectLine(null)
      }

      const annotations: DiffLineAnnotation<NoteMetadata>[] = [
        ...comments
          .filter((comment) => comment.file === selectedFile?.name)
          .map((comment) => ({
            side: comment.side,
            lineNumber: comment.lineNumber,
            metadata: { comment }
          })),
        ...(draft && draft.file === selectedFile?.name
          ? [{ side: draft.side, lineNumber: draft.lineNumber, metadata: { draft } }]
          : [])
      ]

      if (!selectedFile) return <p className="p-5 text-sm text-dim">No file changes in this range.</p>
      return (
        <div className="flex flex-1 flex-col min-h-0 min-w-0">
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2 border-b border-line text-xs">
            <div className="flex min-w-0 flex-1 items-center gap-1 @max-[760px]:basis-full">
              <button className={ICON_BTN} aria-label="Previous file" disabled={selectedIndex === 0} onClick={() => selectFile(files[selectedIndex - 1].name)}>
                <Icon icon="chevron-left" size={16} aria-hidden="true" />
              </button>
              <select
                aria-label="Changed file"
                className={cn(field.control, 'min-w-0 flex-1 max-w-xl px-2 py-1 font-mono text-xs')}
                value={selectedFile.name}
                onChange={(event) => selectFile(event.target.value)}
              >
                {files.map((file) => (
                  <option key={file.name} value={file.name}>
                    {viewed.has(file.name) ? '✓ ' : ''}{file.name}
                  </option>
                ))}
              </select>
              <button className={ICON_BTN} aria-label="Next file" disabled={selectedIndex === files.length - 1} onClick={() => selectFile(files[selectedIndex + 1].name)}>
                <Icon icon="chevron-right" size={16} aria-hidden="true" />
              </button>
              <span className="ml-1 shrink-0 tabular-nums text-dim">{selectedIndex + 1} / {files.length}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-dim">
              {trailing}
              <label className="flex items-center gap-1.5 hover:text-fg">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={viewed.has(selectedFile.name)}
                  onChange={(event) => {
                    const checked = event.target.checked
                    setViewed((previous) => {
                      const next = new Set(previous)
                      if (checked) next.add(selectedFile.name)
                      else next.delete(selectedFile.name)
                      return next
                    })
                  }}
                />
                Viewed
              </label>
              <span className="tabular-nums">{viewedCount} of {files.length} viewed</span>
            </div>
          </div>
          <div key={selectedFile.name} className="flex-1 min-h-0 overflow-auto overscroll-contain">
            <FileDiff
              fileDiff={selectedFile}
              disableWorkerPool
              lineAnnotations={annotations}
              selectedLines={
                draft && draft.file === selectedFile.name
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
                themeType: 'dark',
                diffStyle: 'unified',
                overflow: 'wrap',
                disableFileHeader: true,
                enableLineSelection: true,
                onLineSelectionEnd(range) {
                  if (range === null) return
                  onSelectLine({
                    file: selectedFile.name,
                    side: range.side === 'deletions' ? 'deletions' : 'additions',
                    lineNumber: range.end
                  })
                }
              }}
            />
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

/**
 * The commit list and its rebase action live behind one disclosure in the diff
 * toolbar, so the review surface stays about the code until the developer asks.
 */
function CommitsMenu({ diff, disabled, rebasing, onRebase }: {
  diff: TaskDiff
  disabled: boolean
  rebasing: boolean
  onRebase: () => void
}): JSX.Element {
  const ref = useRef<HTMLDetailsElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent): void => {
      if (!ref.current?.contains(event.target as Node)) ref.current?.removeAttribute('open')
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  const count = diff.commits.length
  return (
    <details ref={ref} className="relative" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="flex cursor-pointer select-none list-none items-center gap-1 hover:text-fg [&::-webkit-details-marker]:hidden">
        {count} commit{count === 1 ? '' : 's'}
        <Icon icon="chevron-down" size={14} aria-hidden="true" />
      </summary>
      <div className="absolute right-0 top-full z-20 mt-1.5 w-[min(460px,80vw)] border border-line bg-raised p-3 text-fg shadow-[0_8px_32px_rgba(0,0,0,0.4)]">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-[11px] text-dim">Commits on this branch</span>
          <button
            className={cn(btn.ghost, 'py-1 text-xs')}
            disabled={disabled || count < 2 || rebasing}
            title={count < 2 ? 'Nothing to rebase: this branch has a single commit' : 'Rewrite these commits'}
            onClick={onRebase}
          >
            {rebasing ? 'Rebasing…' : 'Rebase'}
          </button>
        </div>
        <ul className="max-h-64 overflow-y-auto">
          {diff.commits.map((commit) => <li key={commit.sha} className="flex gap-2 py-1.5 border-t border-line">
            <code className="shrink-0 text-accent">{commit.sha.slice(0, 8)}</code>
            <span className="min-w-0 break-words">{commit.subject}</span>
          </li>)}
        </ul>
      </div>
    </details>
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
  finalizing: 'Saving branch',
  did_not_commit: 'Finisher committing',
  reviewable: 'Ready to review',
  approved: 'Approved',
  no_changes: 'No code changes',
  agent_failed: 'Code not reviewable',
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

function Notice({ tone = 'danger', children }: { tone?: 'danger' | 'warn'; children: ReactNode }): JSX.Element {
  return (
    <div role="alert" className={cn('shrink-0 max-h-20 overflow-auto px-5 py-2 text-xs [overflow-wrap:anywhere]', tone === 'danger' ? 'text-danger bg-danger/8' : 'text-warn bg-warn/8')}>
      {children}
    </div>
  )
}

export function TaskView({ task }: Props): JSX.Element {
  const { snapshot, error: issueError, refresh } = useTaskIssues(task.id, true)
  const issue = task.status !== 'succeeded' && task.status !== 'cancelled' ? snapshot?.children.find((child) => child.status === 'review' &&
    (!snapshot.execution?.currentIssueId || child.id === snapshot.execution.currentIssueId)) : undefined
  const events = useStore((s) => s.eventsByTask[task.id])
  const workspaceName = useStore((s) => s.workspaces.find((workspace) => workspace.id === task.workspaceId)?.name ?? task.workspaceId)
  const project = useStore((s) => s.projects.find((item) => item.id === task.projectId))
  const openTask = useStore((s) => s.openTask)
  const diff = useStore((s) => s.diffsByTask[task.id])
  const diffError = useStore((s) => s.diffErrorsByTask[task.id])
  const loadTaskDiff = useStore((s) => s.loadTaskDiff)
  const [issueDiffState, setIssueDiffState] = useState<{ key: string; diff?: TaskDiff; error?: string }>({ key: '' })
  const [diffAttempt, setDiffAttempt] = useState(0)
  const approveIssue = useStore((s) => s.approveIssue)
  const rejectIssue = useStore((s) => s.rejectIssue)
  const [reviewBusy, setReviewBusy] = useState<'approve' | 'reject' | null>(null)
  const [reviewError, setReviewError] = useState<string | null>(null)
  const [reworkComment, setReworkComment] = useState('')

  const comments = useStore((s) => s.commentsByTask[task.id])
  const loadComments = useStore((s) => s.loadComments)
  const addComment = useStore((s) => s.addComment)
  const removeComment = useStore((s) => s.removeComment)
  const sendComments = useStore((s) => s.sendComments)
  const sending = useStore((s) => s.sendingComments === task.id)
  const commentError = useStore((s) => s.commentError)
  const [draft, setDraft] = useState<CommentDraft | null>(null)
  const settings = useStore((s) => s.settings)
  const supportsCompaction = useStore((s) => s.agents.find((agent) => agent.id === task.agentId)?.supportsCompaction)
  const [compacting, setCompacting] = useState(false)
  const [compactError, setCompactError] = useState('')
  const compactBusy = compacting || task.contextCompacting === true
  const occupancy = contextOccupancy(task.contextUsed, task.contextSize)
  const contextPercent = occupancy.contextSize !== null && occupancy.contextUsed !== null ? Math.round(occupancy.contextUsed / occupancy.contextSize * 100) : null
  const compact = async (): Promise<void> => {
    setCompacting(true)
    setCompactError('')
    try { await window.anvil.tasks.compact(task.id) }
    catch (error) { setCompactError(error instanceof Error ? error.message : String(error)) }
    finally { setCompacting(false) }
  }
  const openRebase = useStore((s) => s.openRebase)
  const rebaseWithAgent = useStore((s) => s.rebaseWithAgent)
  const rebasing = useStore((s) => s.rebasing === task.id)
  const rebaseTaskId = useStore((s) => s.rebaseTaskId)
  const [approvalTaskId, setApprovalTaskId] = useState<string | null>(null)
  const [pullRequestTaskId, setPullRequestTaskId] = useState<string | null>(null)
  const approved = task.deliveryStatus === 'approved'

  const outputRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(Date.now())
  const [follow, setFollow] = useState(true)
  const saving = task.deliveryStatus === 'finalizing' || task.deliveryStatus === 'did_not_commit' || Boolean(issue && !issueIsReviewReady(snapshot))
  const done = task.status === 'succeeded' && task.deliveryStatus === 'no_changes'
  const reviewable = !issue && !saving && (task.deliveryStatus === 'reviewable' || approved)
  const [activePanel, setActivePanel] = useState<TaskPanel>('output')

  useEffect(() => {
    if (!events) void openTask(task.id)
  }, [events, openTask, task.id])

  useEffect(() => {
    if (task.status !== 'running') return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [task.status])

  useEffect(() => {
    const output = outputRef.current
    if (follow && output) output.scrollTop = output.scrollHeight
  }, [events, follow, activePanel, task.status, task.deliveryStatus])

  useEffect(() => {
    if (reviewable && !diff && !diffError) void loadTaskDiff(task.id)
  }, [diff, diffError, loadTaskDiff, reviewable, task.id, task.headCommit, task.baseCommit])

  const issueDiffKey = issue && (issue.status === 'review' || issue.status === 'complete')
    ? JSON.stringify([task.id, issue.id, issue.baseCommit, issue.headCommit, snapshot?.reviewReady, task.headCommit, task.deliveryStatus]) : ''
  const reviewRevision = useRef({ key: issueDiffKey, version: 0 })
  if (reviewRevision.current.key !== issueDiffKey) {
    reviewRevision.current = { key: issueDiffKey, version: reviewRevision.current.version + 1 }
  }
  const issueDiff = issueDiffState.key === issueDiffKey ? issueDiffState.diff : undefined
  const issueDiffError = issueDiffState.key === issueDiffKey ? issueDiffState.error : undefined
  useEffect(() => {
    setDraft(null)
    setReworkComment('')
    setReviewError(null)
  }, [issueDiffKey])
  useEffect(() => {
    let active = true
    setIssueDiffState({ key: issueDiffKey })
    if (issue && issueDiffKey && !saving && issueIsReviewReady(snapshot)) {
      void window.anvil.tasks.issueDiff({ taskId: task.id, issueId: issue.id }).then((diff) => {
        if (active) setIssueDiffState({ key: issueDiffKey, diff })
      }).catch((error: unknown) => {
        if (active) setIssueDiffState({ key: issueDiffKey, error: error instanceof Error ? error.message : String(error) })
      })
    }
    return () => { active = false }
  }, [issueDiffKey, diffAttempt, task.id])

  const retryIssueDiff = (): void => setDiffAttempt((value) => value + 1)
  const reviewDisabled = compactBusy || saving || !!reviewBusy || !!issueError || !issueIsReviewReady(snapshot) || !issueDiff

  const reviewIssue = async (action: 'approve' | 'reject'): Promise<void> => {
    if (!issue || issue.status !== 'review' || reviewDisabled) return
    const submittedVersion = reviewRevision.current.version
    setReviewBusy(action)
    setReviewError(null)
    try {
      if (action === 'approve') await approveIssue(task.id, issue.id, issue.headCommit ?? null)
      else {
        await rejectIssue(task.id, issue.id, reworkComment, issue.headCommit ?? null)
      }
      if (reviewRevision.current.version === submittedVersion) {
        setIssueDiffState({ key: '' })
        setDraft(null)
        setReworkComment('')
      }
      refresh()
    } catch (error) {
      if (reviewRevision.current.version === submittedVersion) setReviewError(error instanceof Error ? error.message : String(error))
    } finally {
      setReviewBusy(null)
    }
  }

  const rebase = (): void => {
    if (settings?.rebaseMode !== 'agent') openRebase(task.id)
    else if (settings.confirmRebase === false) void rebaseWithAgent(task.id)
    else openRebase(task.id)
  }

  useEffect(() => {
    if (!comments) void loadComments(task.id)
  }, [comments, loadComments, task.id])

  const pending = (comments ?? []).filter((comment) => comment.sentAt === null)
  // Submission is visible immediately, even while the turn is still stopping.
  const presentation = taskIssuePresentation(task, snapshot)

  const onScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setFollow(atBottom)
  }

  const panels: readonly TaskPanel[] = ['output', 'changes', 'issues']

  return (
    <div className="@container relative flex flex-col h-full min-w-0 min-h-0 overflow-hidden">
      {pullRequestTaskId === task.id && (
        <OpenPullRequestModal key={task.id} task={task} onClose={() => setPullRequestTaskId(null)} />
      )}
      {approvalTaskId === task.id && (
        <ApproveTaskModal key={task.id} taskId={task.id} onClose={() => setApprovalTaskId(null)} />
      )}
      {rebaseTaskId === task.id &&
        (settings?.rebaseMode === 'agent' ? (
          <AgentRebaseModal taskId={task.id} />
        ) : (
          diff && <RebaseModal taskId={task.id} commits={diff.commits} />
        ))}

      <TaskStackStatus key={`stack-${task.id}`} task={task} />
      <header className="shrink-0 px-5 pt-3 pb-2 @max-[760px]:px-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 @max-[760px]:flex-col">
          <h1 className="min-w-0 flex-1 truncate text-base font-medium leading-snug @max-[760px]:w-full @max-[760px]:flex-none" title={task.title}>{task.title}</h1>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 text-xs @max-[760px]:justify-start">
            {issue ? <>
              <span aria-label="Task status" className={cn('font-medium', ISSUE_STATUS[issuePresentation(issue, snapshot, task).status].tone)}>{saving ? 'Saving changes…' : issuePresentation(issue, snapshot, task).label}{`: ${issue.title}`}</span>
              {issue.status === 'review' && <>
                <button className={cn(btn.ghost, 'ml-2')} disabled={reviewDisabled} onClick={() => void reviewIssue('reject')}>
                  {reviewBusy === 'reject' ? 'Sending…' : 'Request changes'}
                </button>
                <button className={cn(btn.primary, 'bg-ok')} disabled={reviewDisabled} onClick={() => void reviewIssue('approve')}>
                  {reviewBusy === 'approve' ? 'Approving…' : 'Approve'}
                </button>
              </>}
            </> : <>
              <span aria-label="Task status" className="flex items-center gap-2">
                {presentation ? <span className={ISSUE_STATUS[presentation.status].tone}>{presentation.label}: {presentation.issue.title}</span> : <>
                <span className={dot(task.status)} />
                <span className={cn('font-medium', statusTone(task.status))}>{done ? 'Done' : saving ? 'Saving changes…' : STATUS_LABEL[task.status]}</span>
                <span className="text-dim">·</span>
                <span className={deliveryTone(task.deliveryStatus)}>{DELIVERY_LABEL[task.deliveryStatus]}</span>
                </>}
              </span>
              {reviewable && <span className="ml-2 flex items-center gap-2">
                {!approved && pending.length > 0 && <button className={btn.ghost} disabled={sending} onClick={() => void sendComments(task.id)}>
                  {sending ? 'Sending…' : `Send ${pending.length} comment${pending.length === 1 ? '' : 's'}`}
                </button>}
                <button className={btn.ghost} disabled={!diff || rebasing || sending} onClick={() => setPullRequestTaskId(task.id)}>
                  Open PR
                </button>
                {!approved && <button className={cn(btn.primary, 'bg-ok')} disabled={!diff || rebasing || sending || Boolean(task.parentTaskId || task.restackState)} title={task.restackState ? 'Finish restacking before merging' : task.parentTaskId ? 'Merge the parent task first' : undefined} onClick={() => setApprovalTaskId(task.id)}>
                  Approve
                </button>}
              </span>}
            </>}
          </div>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-x-5 gap-y-1 text-[11.5px] text-dim">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate" title={workspaceName} aria-label="Task workspace">{workspaceName}</span>
              <span aria-hidden="true">/</span>
              <span className="truncate" title={project?.path}>{project?.name ?? 'Tasks'}</span>
            </span>
            <span className="flex items-center gap-1.5">
              <AgentIcon agentId={task.agentId} label={task.agentLabel} size={14} />
              {task.agentLabel}
              {task.model && <span className="[overflow-wrap:anywhere]">· {task.model}</span>}
            </span>
            {task.branchName && (
              <span className="flex min-w-0 items-center gap-1.5">
                {task.baseBranch && <span className="truncate" title={task.baseBranch}>{task.baseBranch} ←</span>}
                <CopyableText label="branch name" value={task.branchName} />
              </span>
            )}
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0">ID</span>
              <CopyableText label="task ID" value={task.id} />
            </span>
          </div>
          <div aria-label="Task statistics" role="group" className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <StatBlock label="Elapsed" value={formatDuration(task, now)} />
            <StatBlock label="Tokens" detail={tokenBreakdown(task)} value={
              <span className="flex gap-x-1.5">
                <span>{formatTokens(task.inputTokens)} <span className="text-dim">in</span></span>
                <span className="text-dim">/</span>
                <span>{formatTokens(task.outputTokens)} <span className="text-dim">out</span></span>
              </span>
            } />
            {contextPercent !== null && <StatBlock label="Context" value={<span className={
              task.contextCompactionError || /context[._ ]window|context window|context length/i.test(task.error ?? '') ? 'text-danger'
                : contextPercent >= (settings?.contextCompactionThreshold ?? 75) ? 'text-warn' : undefined
            }>{contextPercent}%</span>} detail={`${formatTokens(task.contextUsed!)} / ${formatTokens(task.contextSize!)} in the current session. Token totals are billed usage, not window fill.`} />}
            <StatBlock label="Cached" value={formatTokens(task.cachedTokens)} detail={`${formatTokens(task.cachedTokens)} cached input`} />
            <StatBlock label="Cost" value={formatCost(task.costUsd)} />
          </div>
        </div>
      </header>

      {issue && issueError && <Notice>Could not refresh subtask. Showing last known data. <button className={btn.text} onClick={refresh}>Retry</button></Notice>}
      {(task.error || task.deliveryError) && <Notice>{task.error || task.deliveryError}</Notice>}
      {task.contextCompactionError && <Notice>{task.contextCompactionError}</Notice>}
      {reviewError && <Notice>{reviewError}</Notice>}
      {(reviewable || issue) && commentError && <Notice>{commentError}</Notice>}

      <div className="flex shrink-0 items-stretch gap-1 px-3 border-b border-line" role="tablist" aria-label="Task panels">
        {panels.map((panel) => {
          const selected = activePanel === panel
          return (
            <button
              key={panel}
              role="tab"
              id={`task-tab-${panel}`}
              aria-controls={`task-panel-${panel}`}
              aria-selected={selected}
              className={cn(
                'relative flex items-center gap-1.5 px-2.5 py-2 text-xs font-medium focus-visible:outline focus-visible:outline-accent',
                selected ? 'text-fg' : 'text-dim hover:text-fg'
              )}
              onClick={() => setActivePanel(panel)}
            >
              {selected && <span aria-hidden="true" className="absolute inset-x-0 -bottom-px h-0.5 bg-accent" />}
              {panel === 'output' && 'Output'}
              {panel === 'issues' && 'Issues'}
              {panel === 'changes' && (issue ? 'Changes' : <>
                Changes{' '}
                <span className="font-mono font-normal tabular-nums text-dim">{saving ? 'Saving…' : reviewable && !diff ? 'Loading…' : task.filesChanged}</span>
                {!saving && (!reviewable || diff) && task.filesChanged > 0 && <>{' '}<span className="font-mono font-normal tabular-nums">
                  <span className="text-ok">+{task.additions}</span> <span className="text-danger">−{task.deletions}</span>
                </span></>}
              </>)}
            </button>
          )
        })}
      </div>

      <div className="flex flex-1 min-h-0 min-w-0">
        <TaskIssues taskId={task.id} active={activePanel === 'issues'} />

        {issue && <section id="task-panel-changes" aria-label="Subtask code changes" className={cn('flex flex-col min-h-0 min-w-0 flex-1', activePanel !== 'changes' && 'hidden')}>
          {issue.status === 'review' && <div className="shrink-0 px-4 py-2 border-b border-line bg-warn/5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <p role="status" className="shrink-0 text-xs text-warn">{saving ? 'Saving changes…' : !issueDiff ? 'Loading code changes…' : 'Waiting for your review. The agent pauses until you approve or request changes.'}</p>
              <textarea
                aria-label="Rework feedback"
                disabled={reviewDisabled}
                className={cn(field.control, 'min-w-56 flex-1 resize-none px-2.5 py-1.5 text-xs')}
                rows={1}
                placeholder="Optional note sent to the agent with a rework request…"
                value={reworkComment}
                onChange={(event) => setReworkComment(event.target.value)}
              />
            </div>
            {pending.length > 0 && <p className="mt-1.5 text-[11px] text-dim">{pending.length} line comment{pending.length === 1 ? '' : 's'} will be sent with the rework request.</p>}
          </div>}
          <>
            {issueDiff && (!issue.baseCommit || !issue.headCommit) && <p className="px-4 py-2 text-xs text-dim">Legacy submission: showing the available recorded range, with task commit fallback.</p>}
            {!saving && !issueDiff && !issueDiffError && <p className="p-5 text-sm text-dim">Loading code changes…</p>}
            {issueDiffError && <div role="alert" className="p-5 text-sm text-danger">
              <p>{issueDiffError}</p>
              <button className={cn(btn.ghost, 'mt-3')} onClick={retryIssueDiff}>Retry</button>
            </div>}
            {issueDiff && <Suspense fallback={<p className="p-5 text-sm text-dim">Loading diff renderer…</p>}>
              <PatchFiles
                key={issueDiffKey}
                patch={issueDiff.patch}
                comments={pending}
                draft={draft}
                trailing={issue.status === 'review' && pending.length === 0 && <span>Select a line to comment</span>}
                onSelectLine={issue.status === 'review' && !reviewDisabled ? setDraft : () => {}}
                onSubmit={(target, body) => {
                  if (issue && reviewDisabled) return
                  void addComment({ taskId: task.id, ...target, body })
                  setDraft(null)
                }}
                onRemove={(id) => { if (!reviewDisabled) void removeComment(task.id, id) }}
              />
            </Suspense>}
          </>
        </section>}

        {!issue && <section id="task-panel-changes" aria-label="Code changes" className={cn('flex flex-col min-h-0 min-w-0 flex-1', activePanel !== 'changes' && 'hidden')}>
          {reviewable ? <>
            {!diff && !diffError && <p className="p-5 text-sm text-dim">Loading code changes…</p>}
            {diffError && <div role="alert" className="p-5 text-sm text-danger">
              <p>{diffError}</p>
              <button className={cn(btn.ghost, 'mt-3')} onClick={() => void loadTaskDiff(task.id)}>Retry</button>
            </div>}
            {diff && <Suspense fallback={<p className="p-5 text-sm text-dim">Loading diff renderer…</p>}>
              <PatchFiles
                key={diff.patch}
                patch={diff.patch}
                comments={comments ?? []}
                draft={draft}
                trailing={<>
                  {!approved && <span>{pending.length ? `${pending.length} comment${pending.length === 1 ? '' : 's'} pending` : 'Select a line to comment'}</span>}
                  <CommitsMenu diff={diff} disabled={approved} rebasing={rebasing} onRebase={rebase} />
                </>}
                onSelectLine={approved ? () => {} : setDraft}
                onSubmit={(target, body) => {
                  void addComment({ taskId: task.id, ...target, body })
                  setDraft(null)
                }}
                onRemove={(id) => void removeComment(task.id, id)}
              />
            </Suspense>}
          </> : <div className={EMPTY_PANEL}>
            <p>{saving ? 'Saving changes…' : done ? 'Done' : task.status === 'running' ? 'The agent is working on this task.' : DELIVERY_LABEL[task.deliveryStatus]}</p>
            <p className="text-xs">{done ? 'No code changes to review.' : saving || task.status === 'running' ? 'The final task diff will appear here when it is ready for review.' : 'There is no final diff available for review.'}</p>
          </div>}
        </section>}

        <section id="task-panel-output" aria-label="Output" className={cn('flex flex-col flex-1 min-h-0 min-w-0', activePanel !== 'output' && 'hidden')}>
          <div className="relative flex-1 min-h-0 min-w-0">
            <div ref={outputRef} role="log" aria-label="Task output" className="h-full min-w-0 px-5 pb-3 overflow-y-auto overscroll-contain font-mono text-[12.5px] leading-[1.55]" onScroll={onScroll}>
              <PromptBlock label="Prompt" text={task.prompt} />
              {!events && <p className={PLACEHOLDER}>Loading output…</p>}
              {events?.length === 0 && task.status !== 'running' && <p className={PLACEHOLDER}>No output recorded.</p>}
              {events?.map((event) => <LogRow key={event.id} event={event} />)}
              <TaskActivity task={task} presentation={presentation} event={events?.at(-1)} />
            </div>
            {!follow && <button className="absolute right-5 bottom-3 px-3 py-1.5 text-xs bg-hover border border-line" onClick={() => setFollow(true)}>
              Jump to latest
            </button>}
          </div>
        </section>
      </div>

      {!isTaskSettled(task) && <TaskSteeringComposer
        key={`composer-${task.id}`}
        task={task}
        compact={{
          visible: Boolean(supportsCompaction && task.sessionId),
          busy: compactBusy,
          disabled: task.status === 'running' && !issueIsReviewReady(snapshot) || compactBusy || task.deliveryStatus === 'finalizing',
          error: compactError,
          onCompact: () => void compact()
        }}
      />}
    </div>
  )
}
