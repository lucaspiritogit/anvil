import type { JSX, ReactNode } from 'react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { formatCost, formatDuration, formatTokens, tokenBreakdown } from '../format'
import { useStore } from '../state/store'
import { btn, cn, deliveryTone, dot, field, statusTone } from '../ui'
import { AgentIcon } from './AgentIcon'
import { AgentRebaseModal } from './AgentRebaseModal'
import { ApproveTaskModal } from './ApproveTaskModal'
import { OpenPullRequestModal } from './OpenPullRequestModal'
import { CopyableText } from './CopyableText'
import { RebaseModal } from './RebaseModal'
import { TaskSteeringComposer } from './TaskSteeringComposer'
import { TaskActivity } from './TaskActivity'
import type { DiffLineAnnotation } from '@pierre/diffs/react'
import type {
  DeliveryStatus,
  Task,
  TaskComment,
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
  onSelectLine: (draft: CommentDraft | null) => void
  onSubmit: (draft: CommentDraft, body: string) => void
  onRemove: (id: string) => void
}

const PLACEHOLDER = 'mx-2 my-1 text-xs text-dim'
/** The note and its composer share a card that hangs off a coloured spine. */
const NOTE_CARD = 'px-3 py-2.5 my-1.5 bg-raised border-l-2 rounded-r-md'

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
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-5 py-3 border-b border-line">
            <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-dim">
              Files · {selectedIndex + 1} of {files.length}
              <select
                aria-label="Changed file"
                className={cn(field.control, 'min-w-0 max-w-sm flex-1 px-2 py-1.5 text-xs')}
                value={selectedFile.name}
                onChange={(event) => selectFile(event.target.value)}
              >
                {files.map((file) => (
                  <option key={file.name} value={file.name}>
                    {viewed.has(file.name) ? '✓ ' : ''}{file.name}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-[11px] text-dim">Unified diff · Wrapped lines</span>
          </div>
          <div key={selectedFile.name} className="flex-1 min-h-0 overflow-auto overscroll-contain">
            <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
              <span className="min-w-0 font-mono text-xs [overflow-wrap:anywhere]">{selectedFile.name}</span>
              <label className="flex items-center gap-2 text-xs text-dim">
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
            </div>
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
          <footer className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-5 py-3 border-t border-line text-xs">
            <span className="text-dim">{viewedCount} of {files.length} files viewed</span>
            <div className="flex gap-2">
              <button className={cn(btn.ghost, 'disabled:opacity-40')} disabled={selectedIndex === 0} onClick={() => selectFile(files[selectedIndex - 1].name)}>
                ← Previous
              </button>
              <button className={cn(btn.ghost, 'disabled:opacity-40')} disabled={selectedIndex === files.length - 1} onClick={() => selectFile(files[selectedIndex + 1].name)}>
                Next file →
              </button>
            </div>
          </footer>
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
      className="grid grid-cols-[96px_minmax(0,1fr)] items-start gap-4 py-1.5 cursor-pointer border-b border-line/55 last:border-b-0 hover:bg-hover/45"
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
    <div className="flex flex-wrap items-baseline gap-x-2 text-xs" title={detail}>
      <span className="text-dim">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  )
}

export function TaskView({ task }: Props): JSX.Element {
  const events = useStore((s) => s.eventsByTask[task.id])
  const openTask = useStore((s) => s.openTask)
  const cancelTask = useStore((s) => s.cancelTask)
  const diff = useStore((s) => s.diffsByTask[task.id])
  const diffError = useStore((s) => s.diffErrorsByTask[task.id])
  const loadTaskDiff = useStore((s) => s.loadTaskDiff)

  const comments = useStore((s) => s.commentsByTask[task.id])
  const loadComments = useStore((s) => s.loadComments)
  const addComment = useStore((s) => s.addComment)
  const removeComment = useStore((s) => s.removeComment)
  const sendComments = useStore((s) => s.sendComments)
  const sending = useStore((s) => s.sendingComments === task.id)
  const commentError = useStore((s) => s.commentError)
  const [draft, setDraft] = useState<CommentDraft | null>(null)
  const settings = useStore((s) => s.settings)
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
  const reviewable = task.deliveryStatus === 'reviewable' || approved
  const [focused, setFocused] = useState(false)
  const [activePanel, setActivePanel] = useState<'output' | 'changes'>('output')

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
  }, [events, follow, focused, activePanel, task.status, task.deliveryStatus])

  useEffect(() => {
    if (reviewable && !diff) void loadTaskDiff(task.id)
  }, [diff, loadTaskDiff, reviewable, task.id])

  useEffect(() => {
    if (!comments) void loadComments(task.id)
  }, [comments, loadComments, task.id])

  const pending = (comments ?? []).filter((comment) => comment.sentAt === null)

  const onScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setFollow(atBottom)
  }

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
      <header className="shrink-0 max-h-[35%] overflow-y-auto px-6 py-4 @max-[760px]:px-4 [@media(max-height:600px)]:py-2">
        <div className="flex flex-wrap gap-2 items-center justify-between text-xs">
          <span className="text-dim">Tasks / Agent run</span>
          <div className="flex flex-wrap gap-2 items-center">
            <span className={dot(task.status)} />
            <span className={statusTone(task.status)}>{STATUS_LABEL[task.status]}</span>
            <span className="text-dim">·</span>
            <span className={deliveryTone(task.deliveryStatus)}>{DELIVERY_LABEL[task.deliveryStatus]}</span>
            {task.status === 'running' && (
              <button className={cn(btn.danger, 'ml-2')} onClick={() => void cancelTask(task.id)}>Stop</button>
            )}
          </div>
        </div>
        <h1 className="my-2.5 text-[22px] font-medium leading-snug [overflow-wrap:anywhere] @max-[760px]:text-xl [@media(max-height:600px)]:my-1">{task.title}</h1>
        <div className="flex flex-wrap gap-x-4 gap-y-2 items-center text-xs text-dim">
          <span className="flex items-center gap-2">
            <AgentIcon agentId={task.agentId} label={task.agentLabel} size={18} />
            {task.agentLabel}
          </span>
          {task.model && <span className="[overflow-wrap:anywhere]">{task.model}</span>}
          {task.branchName && (
            <span className="flex min-w-0 items-center gap-2">
              {task.baseBranch && <span className="truncate" title={task.baseBranch}>{task.baseBranch} ←</span>}
              <CopyableText label="branch name" value={task.branchName} />
            </span>
          )}
          <span className="flex min-w-0 items-center gap-2">
            <span className="shrink-0">Task ID</span>
            <CopyableText label="task ID" value={task.id} />
          </span>
        </div>
      </header>

      <div aria-label="Task statistics" role="group" className="flex shrink-0 flex-wrap items-center gap-x-7 gap-y-2 px-6 py-3 bg-raised border-y border-line @max-[760px]:px-4 [@media(max-height:600px)]:py-2">
        <StatBlock label="Elapsed" value={formatDuration(task, now)} />
        <StatBlock label="Tokens" detail={tokenBreakdown(task)} value={
          <span className="flex flex-wrap gap-x-2">
            <span>{formatTokens(task.inputTokens)} <span className="text-dim">in</span></span>
            <span className="text-dim">/</span>
            <span>{formatTokens(task.outputTokens)} <span className="text-dim">out</span></span>
          </span>
        } />
        <StatBlock label="Cached" value={formatTokens(task.cachedTokens)} detail={`${formatTokens(task.cachedTokens)} cached input`} />
        <StatBlock label="Cost" value={formatCost(task.costUsd)} />
      </div>

      {(task.error || task.deliveryError) && <div role="alert" className="shrink-0 max-h-20 overflow-auto px-6 py-2.5 text-danger bg-danger/8">{task.error || task.deliveryError}</div>}

      <div className="flex shrink-0 gap-4 px-5 border-b border-line" role="tablist" aria-label="Task panels">
        {(['output', 'changes'] as const).map((panel) => (
          <button
            key={panel}
            role="tab"
            aria-selected={activePanel === panel}
            className={cn('py-2 text-xs border-b-2', activePanel === panel ? 'text-accent border-accent' : 'text-dim border-transparent')}
            onClick={() => { setActivePanel(panel); setFocused(false) }}
          >
            {panel === 'output' ? 'Output' : `Changes · ${task.filesChanged}`}
          </button>
        ))}
      </div>

      <div className={cn('grid flex-1 min-h-0 min-w-0 @max-[760px]:flex', activePanel === 'output' || focused ? 'grid-cols-1' : 'grid-cols-[minmax(0,1fr)_320px]')}>
        <section aria-label="Code changes" className={cn('flex flex-col min-h-0 min-w-0 flex-1', activePanel !== 'changes' && 'hidden')}>
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-5 py-3 border-b border-line">
            <div className="flex gap-3 items-center text-sm">
              <h2 className="font-medium text-accent">Changes <span className="ml-1 text-dim">{task.filesChanged}</span></h2>
              <span className="text-xs"><span className="text-ok">+{task.additions}</span> <span className="text-danger">−{task.deletions}</span></span>
            </div>
            <button className={cn(btn.ghost, 'text-xs @max-[760px]:hidden')} aria-pressed={focused} onClick={() => setFocused((value) => !value)}>
              {focused ? 'Show output' : 'Focus diff'}
            </button>
          </div>
          {reviewable ? <>
            <div className="shrink-0 max-h-[40%] overflow-auto px-5 py-3 border-b border-line">
              <div className="flex flex-wrap gap-2 items-center justify-between text-xs">
                <span className="text-dim">{approved ? 'Approved' : pending.length ? `${pending.length} comments pending` : 'Select a line to comment'}</span>
                <div className="flex gap-2">
                  <button className={btn.ghost} disabled={approved || !pending.length || sending} onClick={() => void sendComments(task.id)}>
                    {sending ? 'Sending…' : 'Send comments'}
                  </button>
                  <button className={btn.ghost} disabled={!diff || rebasing || sending} onClick={() => setPullRequestTaskId(task.id)}>
                    Open PR
                  </button>
                  <button className={cn(btn.primary, 'bg-ok disabled:opacity-45')} disabled={approved || !diff || rebasing || sending} onClick={() => setApprovalTaskId(task.id)}>
                    {approved ? 'Approved' : 'Approve'}
                  </button>
                </div>
              </div>
              {commentError && <p role="alert" className="mt-2 text-xs text-danger">{commentError}</p>}
              {diff && <details className="mt-2 text-xs">
                <summary className="cursor-pointer text-dim">{diff.commits.length} commit{diff.commits.length === 1 ? '' : 's'}</summary>
                <div className="flex justify-end my-2">
                  <button
                    className={btn.ghost}
                    disabled={approved || diff.commits.length < 2 || rebasing}
                    title={diff.commits.length < 2 ? 'Nothing to rebase: this branch has a single commit' : 'Rewrite these commits'}
                    onClick={() => {
                      if (settings?.rebaseMode !== 'agent') openRebase(task.id)
                      else if (settings.confirmRebase === false) void rebaseWithAgent(task.id)
                      else openRebase(task.id)
                    }}
                  >
                    {rebasing ? 'Rebasing…' : 'Rebase'}
                  </button>
                </div>
                {diff.commits.map((commit) => <div key={commit.sha} className="flex gap-2 py-1.5 border-t border-line">
                  <code className="text-accent">{commit.sha.slice(0, 8)}</code>
                  <span className="min-w-0 break-words">{commit.subject}</span>
                </div>)}
              </details>}
            </div>
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
                onSelectLine={approved ? () => {} : setDraft}
                onSubmit={(target, body) => {
                  void addComment({ taskId: task.id, ...target, body })
                  setDraft(null)
                }}
                onRemove={(id) => void removeComment(task.id, id)}
              />
            </Suspense>}
          </> : <div className="grid flex-1 place-content-center gap-2 p-6 text-center text-sm text-dim">
            <p>{task.status === 'running' ? 'The agent is working on this task.' : DELIVERY_LABEL[task.deliveryStatus]}</p>
            <p className="text-xs">{task.status === 'running' ? 'The final task diff will appear here when it is ready for review.' : 'There is no final diff available for review.'}</p>
          </div>}
        </section>

        <aside aria-label="Prompt and output" className={cn('flex flex-col flex-1 min-h-0 min-w-0 bg-raised', activePanel === 'changes' && 'border-l border-line @max-[760px]:hidden', activePanel === 'changes' && focused && 'hidden')}>
          <div className="shrink-0 px-5 pt-4 pb-3 border-b border-line [@media(max-height:600px)]:py-2">
            <h2 className="mb-2 text-xs font-medium [@media(max-height:600px)]:mb-1">Original prompt</h2>
            <div role="region" aria-label="Task prompt" tabIndex={0} className="max-h-24 overflow-y-auto overscroll-contain text-[13px] leading-relaxed text-dim whitespace-pre-wrap [overflow-wrap:anywhere] @max-[760px]:max-h-12 [@media(max-height:600px)]:max-h-6">
              {task.prompt}
            </div>
          </div>
          <div className="grid shrink-0 grid-cols-[96px_minmax(0,1fr)] gap-4 px-5 py-2 border-b border-line text-[11px] text-dim">
            <span>Event type</span>
            <span>Result · {events?.length ?? 0} events</span>
          </div>
          <div className="relative flex-1 min-h-0 min-w-0">
            <div ref={outputRef} role="log" aria-label="Task output" className="h-full min-w-0 px-5 pb-3 overflow-y-auto overscroll-contain font-mono text-[12.5px] leading-[1.55]" onScroll={onScroll}>
              {!events && <p className={PLACEHOLDER}>Loading output…</p>}
              {events?.length === 0 && task.status !== 'running' && <p className={PLACEHOLDER}>No output recorded.</p>}
              {events?.map((event) => <LogRow key={event.id} event={event} />)}
              <TaskActivity task={task} event={events?.at(-1)} />
            </div>
            {!follow && <button className="absolute right-5 bottom-3 px-3 py-1.5 text-xs bg-hover border border-line rounded-full" onClick={() => setFollow(true)}>
              Jump to latest
            </button>}
          </div>
          <TaskSteeringComposer key={task.id} task={task} hidden={activePanel !== 'output'} />
        </aside>
      </div>
    </div>
  )
}
