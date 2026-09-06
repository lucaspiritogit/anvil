import type { JSX, ReactNode } from 'react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { formatCost, formatDuration, formatTokens, tokenBreakdown } from '../format'
import { useStore } from '../state/store'
import { btn, cn, deliveryTone, dot, field, statusTone } from '../ui'
import { AgentIcon } from './AgentIcon'
import { AgentRebaseModal } from './AgentRebaseModal'
import { RebaseModal } from './RebaseModal'
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
      if (files.length === 0) return <p className={PLACEHOLDER}>No file changes in this range.</p>
      return (
        <>
          {files.map((file, index) => {
            const name = file.name ?? `file-${index}`
            // Saved notes plus the line currently being written on, so the
            // composer renders in place like any other annotation.
            const annotations: DiffLineAnnotation<NoteMetadata>[] = [
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
            return (
              <FileDiff
                key={`${name}-${index}`}
                fileDiff={file}
                disableWorkerPool
                lineAnnotations={annotations}
                selectedLines={
                  draft && draft.file === name
                    ? { start: draft.lineNumber, end: draft.lineNumber, side: draft.side }
                    : null
                }
                renderAnnotation={({ metadata }) =>
                  metadata.comment ? (
                    <CommentNote
                      comment={metadata.comment}
                      onRemove={() => onRemove(metadata.comment.id)}
                    />
                  ) : (
                    <CommentComposer
                      onCancel={() => onSelectLine(null)}
                      onSubmit={(body) => onSubmit(metadata.draft, body)}
                    />
                  )
                }
                options={{
                  themeType: 'dark',
                  diffStyle: 'unified',
                  overflow: 'scroll',
                  enableLineSelection: true,
                  onLineSelectionEnd(range) {
                    if (range === null) return
                    onSelectLine({
                      file: name,
                      side: range.side === 'deletions' ? 'deletions' : 'additions',
                      lineNumber: range.end
                    })
                  }
                }}
              />
            )
          })}
        </>
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
      className="grid grid-cols-[104px_minmax(0,1fr)] gap-4 py-[5px] cursor-pointer border-b border-line/55 hover:bg-hover/45"
      onClick={() => setExpanded((value) => !value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          setExpanded((value) => !value)
        }
      }}
    >
      <span
        className={cn(
          'overflow-hidden text-ellipsis whitespace-nowrap select-none',
          uncommitted ? 'text-warn' : KIND_TONE[event.category]
        )}
      >
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

/** One cell of the header's metric strip: a labelled reading of the task. */
function StatBlock({
  label,
  value,
  detail,
  tone
}: {
  label: string
  /** A node, not a string, so a stat can split itself into parts. */
  value: ReactNode
  detail?: string
  tone: TaskStatus
}): JSX.Element {
  return (
    <div
      className="flex flex-col gap-[5px] px-3.5 py-2.5 border-l border-line first:border-l-0"
      title={detail}
    >
      <span className="flex gap-[7px] items-center text-xs text-fg">
        <span className={dot(tone)} />
        {label}
      </span>
      <span className="pl-3.5 font-mono text-[13px] text-dim">{value}</span>
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
  const approveTask = useStore((s) => s.approveTask)
  const approved = task.deliveryStatus === 'approved'

  const outputRef = useRef<HTMLDivElement>(null)
  const [now, setNow] = useState(Date.now())
  const [follow, setFollow] = useState(true)
  const [panel, setPanel] = useState<'output' | 'changes'>('output')

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
  }, [events, follow, panel])

  useEffect(() => {
    if (panel === 'changes' && (task.deliveryStatus === 'reviewable' || approved) && !diff) {
      void loadTaskDiff(task.id)
    }
  }, [approved, diff, loadTaskDiff, panel, task.deliveryStatus, task.id])

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
    <div className="relative flex flex-col h-full min-w-0 min-h-0 overflow-hidden">
      {rebaseTaskId === task.id &&
        (settings?.rebaseMode === 'agent' ? (
          <AgentRebaseModal taskId={task.id} />
        ) : (
          diff && <RebaseModal taskId={task.id} commits={diff.commits} />
        ))}
      <header className="flex shrink-0 flex-col gap-2.5 max-h-[40%] px-4 pt-3.5 pb-3 overflow-y-auto break-words">
        <div className="flex gap-3 items-start justify-between">
          <h1 className="text-[17px] font-semibold leading-[1.35] text-fg">{task.title}</h1>
          {task.status === 'running' && (
            <button className={btn.danger} onClick={() => void cancelTask(task.id)}>
              Stop
            </button>
          )}
        </div>

        <div className="flex gap-2.5 items-center">
          <AgentIcon agentId={task.agentId} label={task.agentLabel} size={26} />
          <div className="flex flex-col gap-px min-w-0">
            <span className="text-[13px] font-semibold text-fg">{task.agentLabel}</span>
            {task.model && (
              <span className="overflow-hidden font-mono text-xs text-dim text-ellipsis whitespace-nowrap">
                {task.model}
              </span>
            )}
          </div>
          <div className="flex gap-3 items-center ml-auto pl-3 text-xs">
            <span className={statusTone(task.status)}>{STATUS_LABEL[task.status]}</span>
            <span className={deliveryTone(task.deliveryStatus)}>
              {DELIVERY_LABEL[task.deliveryStatus] ?? task.deliveryStatus}
            </span>
          </div>
        </div>

        <div className="grid auto-cols-[minmax(0,1fr)] grid-flow-col overflow-hidden bg-raised border border-line rounded-card">
          <StatBlock label="Elapsed" value={formatDuration(task, now)} tone={task.status} />
          <StatBlock
            label="Tokens"
            value={
              <span className="flex flex-wrap gap-x-2.5">
                <span>
                  {formatTokens(task.inputTokens)}
                  <span className="ml-1 text-dim/60">in</span>
                </span>
                <span>
                  {formatTokens(task.outputTokens)}
                  <span className="ml-1 text-dim/60">out</span>
                </span>
              </span>
            }
            detail={tokenBreakdown(task)}
            tone={task.status}
          />
          <StatBlock label="Cost" value={formatCost(task.costUsd)} tone={task.status} />
        </div>

        {task.prompt.trim() !== task.title && (
          <p className="text-[13px] text-dim whitespace-pre-wrap">{task.prompt}</p>
        )}
      </header>

      {task.error && <div className="px-4 py-2.5 text-danger bg-danger/8">{task.error}</div>}

      <div className="flex shrink-0 gap-1 px-4 pt-2 border-b border-line">
        <button
          className={cn(
            'px-2.5 pt-[7px] pb-[9px] border-b-2',
            panel === 'output' ? 'text-fg border-b-accent' : 'text-dim border-b-transparent'
          )}
          onClick={() => setPanel('output')}
        >
          Output
        </button>
        {(task.deliveryStatus === 'reviewable' || approved) && (
          <button
            className={cn(
              'px-2.5 pt-[7px] pb-[9px] border-b-2',
              panel === 'changes' ? 'text-fg border-b-accent' : 'text-dim border-b-transparent'
            )}
            onClick={() => setPanel('changes')}
          >
            Changes {task.filesChanged > 0 ? `(${task.filesChanged})` : ''}
          </button>
        )}
      </div>

      {panel === 'output' ? (
        <div
          ref={outputRef}
          role="log"
          aria-label="Task output"
          className="flex-1 min-w-0 min-h-0 px-4 py-3 overflow-y-auto overscroll-contain font-mono text-[12.5px] leading-[1.55]"
          onScroll={onScroll}
        >
          {!events && <p className={PLACEHOLDER}>Loading output…</p>}
          {events?.length === 0 && <p className={PLACEHOLDER}>Waiting for output…</p>}
          {events?.map((event) => (
            <LogRow key={event.id} event={event} />
          ))}
        </div>
      ) : (
        <div className="flex-1 min-h-0 px-4 pt-3.5 pb-6 overflow-auto [&_[data-diffs]]:border [&_[data-diffs]]:border-line [&_[data-diffs]]:rounded-md">
          {/*
           * Pinned to the top of the scrolling review pane. Negative margins pull
           * it over the pane's own padding so diff content passes underneath, and
           * it outranks the diff renderer's own sticky headers.
           */}
          <div className="sticky top-0 z-[5] -mx-4 -mt-3.5 mb-3.5 px-4 py-3 bg-canvas border-b border-line">
            <div className="flex items-center justify-between text-xs text-dim">
              <div className="flex gap-2 items-baseline">
                <strong className="font-mono text-fg">{task.branchName}</strong>
                <span>from {task.baseBranch}</span>
              </div>
              <span>
                {task.filesChanged} files · <b className="text-ok">+{task.additions}</b> ·{' '}
                <b className="text-danger">-{task.deletions}</b>
              </span>
            </div>
            <div className="flex gap-3 items-center justify-end mt-2.5">
              <span className="text-xs text-dim">
                {approved
                  ? 'Approved'
                  : pending.length
                    ? `${pending.length} comment${pending.length === 1 ? '' : 's'} pending`
                    : 'Select a line to comment'}
              </span>
              <button
                className={btn.primary}
                disabled={approved || !pending.length || sending}
                onClick={() => void sendComments(task.id)}
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
              <button
                className="px-3.5 py-[7px] rounded-md font-medium whitespace-nowrap bg-ok text-canvas disabled:bg-transparent disabled:text-ok disabled:border disabled:border-ok/40 disabled:cursor-default"
                disabled={approved}
                title={approved ? 'Already approved' : 'Accept this work and close the review'}
                onClick={() => void approveTask(task.id)}
              >
                {approved ? 'Approved' : 'Approve'}
              </button>
            </div>
            {commentError && <div className="mt-2 text-xs text-danger">{commentError}</div>}
          </div>
          {!diff && !diffError && <p className={PLACEHOLDER}>Loading code changes…</p>}
          {diffError && <div className="px-4 py-2.5 text-danger bg-danger/8">{diffError}</div>}
          {diff && (
            <>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-dim">
                  {diff.commits.length} commit{diff.commits.length === 1 ? '' : 's'}
                </span>
                <button
                  className={btn.ghost}
                  disabled={approved || diff.commits.length < 2 || rebasing}
                  title={
                    diff.commits.length < 2
                      ? 'Nothing to rebase: this branch has a single commit'
                      : settings?.rebaseMode === 'agent'
                        ? 'Let the agent rewrite these commits'
                        : 'Choose what happens to each commit'
                  }
                  onClick={() => {
                    // Agent mode hands the branch straight over; manual mode
                    // opens the editor, which is its own confirmation.
                    if (settings?.rebaseMode !== 'agent') openRebase(task.id)
                    else if (settings.confirmRebase === false) void rebaseWithAgent(task.id)
                    else openRebase(task.id)
                  }}
                >
                  {rebasing ? 'Rebasing…' : 'Rebase'}
                </button>
              </div>
              <div className="mb-3 overflow-hidden border border-line rounded-md">
                {diff.commits.map((commit) => (
                  <div
                    key={commit.sha}
                    className="flex gap-2.5 px-2.5 py-[7px] text-[11px] border-b border-line last:border-b-0"
                  >
                    <code className="text-accent">{commit.sha.slice(0, 8)}</code>
                    <span>{commit.subject}</span>
                  </div>
                ))}
              </div>
              <Suspense fallback={<p className={PLACEHOLDER}>Loading diff renderer…</p>}>
                <PatchFiles
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
              </Suspense>
            </>
          )}
        </div>
      )}

      {panel === 'output' && !follow && (
        <button
          className="absolute right-[22px] bottom-[18px] px-3 py-1.5 text-xs bg-hover border border-line rounded-full"
          onClick={() => setFollow(true)}
        >
          Jump to latest
        </button>
      )}
    </div>
  )
}
