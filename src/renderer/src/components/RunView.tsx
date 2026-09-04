import type { JSX } from 'react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../state/store'
import type { Run } from '@shared/types'

interface Props {
  run: Run
}

const PatchFiles = lazy(async () => {
  const [{ FileDiff }, { parsePatchFiles }] = await Promise.all([
    import('@pierre/diffs/react'),
    import('@pierre/diffs')
  ])

  return {
    default: function PatchFiles({ patch }: { patch: string }): JSX.Element {
      const files = useMemo(
        () => parsePatchFiles(patch).flatMap((parsed) => parsed.files),
        [patch]
      )
      if (files.length === 0) return <p className="empty">No file changes in this range.</p>
      return (
        <>
          {files.map((file, index) => (
            <FileDiff
              key={`${file.name}-${index}`}
              fileDiff={file}
              disableWorkerPool
              options={{ themeType: 'dark', diffStyle: 'unified', overflow: 'scroll' }}
            />
          ))}
        </>
      )
    }
  }
})

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
    if (panel === 'changes' && run.deliveryStatus === 'reviewable' && !diff) {
      void loadRunDiff(run.id)
    }
  }, [diff, loadRunDiff, panel, run.deliveryStatus, run.id])

  const onScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    setFollow(atBottom)
  }

  return (
    <div className="runview">
      <div className="run-meta">
        <span className={`badge badge-${run.status}`}>Agent {run.status}</span>
        <span className={`badge delivery-badge delivery-${run.deliveryStatus}`}>
          {run.deliveryStatus === 'reviewable'
            ? 'Reviewable'
            : run.deliveryStatus === 'did_not_commit'
              ? 'Finisher committing'
            : run.deliveryStatus === 'no_changes'
              ? 'No code changes'
              : run.deliveryStatus === 'finalizing'
                ? 'Saving branch'
                : run.deliveryStatus === 'working'
                  ? 'Branch active'
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
        {run.deliveryStatus === 'reviewable' && (
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
            <div
              key={event.id}
              className={`line line-${event.stream} event-${event.kind}`}
            >
              {event.text || ' '}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      ) : (
        <div className="review-view">
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
          {!diff && !diffError && <p className="empty">Loading code changes…</p>}
          {diffError && <div className="run-error">{diffError}</div>}
          {diff && (
            <>
              <div className="commit-list">
                {diff.commits.map((commit) => (
                  <div key={commit.sha}>
                    <code>{commit.sha.slice(0, 8)}</code>
                    <span>{commit.subject}</span>
                  </div>
                ))}
              </div>
              <Suspense fallback={<p className="empty">Loading diff renderer…</p>}>
                <PatchFiles patch={diff.patch} />
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
