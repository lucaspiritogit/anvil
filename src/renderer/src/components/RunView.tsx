import type { JSX } from 'react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { AgentRebaseModal } from './AgentRebaseModal'
import { RebaseModal } from './RebaseModal'
import type { DiffLineAnnotation } from '@pierre/diffs/react'
import type { Run, RunComment, RunEvent, RunEventCategory } from '@shared/types'

interface Props {
  run: Run
}

/** Either a saved note or the line currently being written on. */
type NoteMetadata = { comment: RunComment; draft?: undefined } | { comment?: undefined; draft: CommentDraft }

interface CommentDraft {
  file: string
  side: RunComment['side']
  lineNumber: number
}

interface PatchFilesProps {
  patch: string
  comments: RunComment[]
  draft: CommentDraft | null
  onSelectLine: (draft: CommentDraft | null) => void
  onSubmit: (draft: CommentDraft, body: string) => void
  onRemove: (id: string) => void
}

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
      if (files.length === 0) return <p className="empty">No file changes in this range.</p>
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
  comment: RunComment
  onRemove: () => void
}): JSX.Element {
  return (
    <div className={`review-note ${comment.sentAt === null ? '' : 'review-note-sent'}`}>
      <p>{comment.body}</p>
      {comment.sentAt === null ? (
        <button className="text-btn" onClick={onRemove}>
          Remove
        </button>
      ) : (
        <span className="review-note-status">Sent</span>
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
    <div className="review-composer">
      <textarea
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
      <div className="review-composer-actions">
        <button className="ghost-btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary-btn" disabled={!body.trim()} onClick={() => onSubmit(body)}>
          Add comment
        </button>
      </div>
    </div>
  )
}

const CATEGORY_LABEL: Record<RunEventCategory, string> = {
  message: 'message',
  thinking: 'thinking',
  tool_use: 'tool_use',
  tool_result: 'tool_result',
  system: 'system',
  error: 'error'
}

function LogRow({ event }: { event: RunEvent }): JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <div
      className={`log-row log-${event.category} event-${event.kind}${
        expanded ? ' log-row-expanded' : ''
      }`}
      onClick={() => setExpanded((value) => !value)}
    >
      <span className="log-kind">{CATEGORY_LABEL[event.category]}</span>
      <span className="log-text">{event.text || ' '}</span>
    </div>
  )
}

function duration(run: Run): string {
  const end = run.endedAt ?? Date.now()
  const seconds = Math.max(0, Math.round((end - run.startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function RunView({ run }: Props): JSX.Element {
  const events = useStore((s) => s.eventsByRun[run.id])
  const openRun = useStore((s) => s.openRun)
  const cancelRun = useStore((s) => s.cancelRun)
  const diff = useStore((s) => s.diffsByRun[run.id])
  const diffError = useStore((s) => s.diffErrorsByRun[run.id])
  const loadRunDiff = useStore((s) => s.loadRunDiff)

  const comments = useStore((s) => s.commentsByRun[run.id])
  const loadComments = useStore((s) => s.loadComments)
  const addComment = useStore((s) => s.addComment)
  const removeComment = useStore((s) => s.removeComment)
  const sendComments = useStore((s) => s.sendComments)
  const sending = useStore((s) => s.sendingComments === run.id)
  const commentError = useStore((s) => s.commentError)
  const [draft, setDraft] = useState<CommentDraft | null>(null)
  const settings = useStore((s) => s.settings)
  const openRebase = useStore((s) => s.openRebase)
  const rebaseWithAgent = useStore((s) => s.rebaseWithAgent)
  const rebasing = useStore((s) => s.rebasing === run.id)
  const rebaseRunId = useStore((s) => s.rebaseRunId)
  const approveRun = useStore((s) => s.approveRun)
  const approved = run.deliveryStatus === 'approved'

  const bottomRef = useRef<HTMLDivElement>(null)
  const [follow, setFollow] = useState(true)
  const [panel, setPanel] = useState<'output' | 'changes'>(
    run.deliveryStatus === 'reviewable' ? 'changes' : 'output'
  )

  useEffect(() => {
    if (!events) void openRun(run.id)
  }, [events, openRun, run.id])

  useEffect(() => {
    if (follow) bottomRef.current?.scrollIntoView({ block: 'end' })
  }, [events, follow])

  useEffect(() => {
    if (panel === 'changes' && (run.deliveryStatus === 'reviewable' || approved) && !diff) {
      void loadRunDiff(run.id)
    }
  }, [approved, diff, loadRunDiff, panel, run.deliveryStatus, run.id])

  useEffect(() => {
    if (!comments) void loadComments(run.id)
  }, [comments, loadComments, run.id])

  const pending = (comments ?? []).filter((comment) => comment.sentAt === null)

  const onScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setFollow(atBottom)
  }

  return (
    <div className="runview">
      {rebaseRunId === run.id &&
        (settings?.rebaseMode === 'agent' ? (
          <AgentRebaseModal runId={run.id} />
        ) : (
          diff && <RebaseModal runId={run.id} commits={diff.commits} />
        ))}
      <div className="run-meta">
        <span className={`badge badge-${run.status}`}>Agent {run.status}</span>
        <span className={`badge delivery-badge delivery-${run.deliveryStatus}`}>
          {run.deliveryStatus === 'approved'
            ? 'Approved'
          : run.deliveryStatus === 'reviewable'
            ? 'Reviewable'
            : run.deliveryStatus === 'did_not_commit'
              ? 'Finisher committing'
            : run.deliveryStatus === 'no_changes'
              ? 'No code changes'
              : run.deliveryStatus === 'finalizing'
                ? 'Saving branch'
                : run.deliveryStatus === 'working'
                  ? 'Branch active'
                  : run.deliveryStatus === 'unavailable'
                    ? 'Not tracked by Git'
                  : run.deliveryStatus === 'agent_failed'
                    ? 'Code not reviewable'
                    : run.deliveryStatus === 'failed'
                      ? 'Delivery failed'
                      : run.deliveryStatus}
        </span>
        <span className="meta-item">{run.agentLabel}</span>
        {run.model && <span className="meta-item mono">{run.model}</span>}
        <span className="meta-item">{duration(run)}</span>
        {run.status === 'running' && (
          <button className="danger-btn" onClick={() => void cancelRun(run.id)}>
            Stop
          </button>
        )}
      </div>

      <div className="run-prompt">{run.prompt}</div>

      {run.error && <div className="run-error">{run.error}</div>}

      <div className="run-panels">
        <button className={panel === 'output' ? 'run-panel-active' : ''} onClick={() => setPanel('output')}>
          Output
        </button>
        {(run.deliveryStatus === 'reviewable' || approved) && (
          <button
            className={panel === 'changes' ? 'run-panel-active' : ''}
            onClick={() => setPanel('changes')}
          >
            Changes {run.filesChanged > 0 ? `(${run.filesChanged})` : ''}
          </button>
        )}
      </div>

      {panel === 'output' ? (
        <div className="run-log" onScroll={onScroll}>
          {!events && <p className="empty">Loading output…</p>}
          {events?.length === 0 && <p className="empty">Waiting for output…</p>}
          {events?.map((event) => (
            <LogRow key={event.id} event={event} />
          ))}
          <div ref={bottomRef} />
        </div>
      ) : (
        <div className="review-view">
          <div className="review-bar">
            <div className="review-summary">
              <div>
                <strong>{run.branchName}</strong>
                <span>from {run.baseBranch}</span>
              </div>
              <span>
                {run.filesChanged} files · <b className="additions">+{run.additions}</b> ·{' '}
                <b className="deletions">-{run.deletions}</b>
              </span>
            </div>
            <div className="review-send">
              <span className="review-pending">
                {approved
                  ? 'Approved'
                  : pending.length
                    ? `${pending.length} comment${pending.length === 1 ? '' : 's'} pending`
                    : 'Select a line to comment'}
              </span>
              <button
                className="primary-btn"
                disabled={approved || !pending.length || sending}
                onClick={() => void sendComments(run.id)}
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
              <button
                className="approve-btn"
                disabled={approved}
                title={approved ? 'Already approved' : 'Accept this work and close the review'}
                onClick={() => void approveRun(run.id)}
              >
                {approved ? 'Approved' : 'Approve'}
              </button>
            </div>
            {commentError && <div className="review-error">{commentError}</div>}
          </div>
          {!diff && !diffError && <p className="empty">Loading code changes…</p>}
          {diffError && <div className="run-error">{diffError}</div>}
          {diff && (
            <>
              <div className="commit-head">
                <span className="commit-count">
                  {diff.commits.length} commit{diff.commits.length === 1 ? '' : 's'}
                </span>
                <button
                  className="ghost-btn"
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
                    if (settings?.rebaseMode !== 'agent') openRebase(run.id)
                    else if (settings.confirmRebase === false) void rebaseWithAgent(run.id)
                    else openRebase(run.id)
                  }}
                >
                  {rebasing ? 'Rebasing…' : 'Rebase'}
                </button>
              </div>
              <div className="commit-list">
                {diff.commits.map((commit) => (
                  <div key={commit.sha}>
                    <code>{commit.sha.slice(0, 8)}</code>
                    <span>{commit.subject}</span>
                  </div>
                ))}
              </div>
              <Suspense fallback={<p className="empty">Loading diff renderer…</p>}>
                <PatchFiles
                  patch={diff.patch}
                  comments={comments ?? []}
                  draft={draft}
                  onSelectLine={approved ? () => {} : setDraft}
                  onSubmit={(target, body) => {
                    void addComment({ runId: run.id, ...target, body })
                    setDraft(null)
                  }}
                  onRemove={(id) => void removeComment(run.id, id)}
                />
              </Suspense>
            </>
          )}
        </div>
      )}

      {panel === 'output' && !follow && (
        <button className="follow-btn" onClick={() => setFollow(true)}>
          Jump to latest
        </button>
      )}
    </div>
  )
}
