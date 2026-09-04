import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../state/store'
import type { RebaseAction, RebaseStep, RunCommit } from '@shared/types'

const ACTIONS: { value: RebaseAction; label: string; hint: string }[] = [
  { value: 'pick', label: 'pick', hint: 'Keep as its own commit' },
  { value: 'squash', label: 'squash', hint: 'Fold into the commit above' },
  { value: 'drop', label: 'drop', hint: 'Discard this commit entirely' }
]

/**
 * A small interactive rebase. Commits are listed oldest first, the way
 * `git rebase -i` writes its todo list, so "squash" folding upward reads the
 * same as it does in git.
 */
export function RebaseModal({ runId, commits }: { runId: string; commits: RunCommit[] }): JSX.Element {
  const openRebase = useStore((s) => s.openRebase)
  const rebaseRun = useStore((s) => s.rebaseRun)
  const rebasing = useStore((s) => s.rebasing === runId)
  const run = useStore((s) => s.runs.find((item) => item.id === runId))
  const error = useStore((s) => s.commentError)

  // `getDiff` returns newest first; a rebase todo list reads oldest first.
  const ordered = useMemo(() => [...commits].reverse(), [commits])
  const [steps, setSteps] = useState<RebaseStep[]>(() =>
    ordered.map((commit, index) => ({
      sha: commit.sha,
      // Everything folds into the first commit by default, which is the squash
      // this modal replaced.
      action: index === 0 ? 'pick' : 'squash',
      message: commit.subject
    }))
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') openRebase(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openRebase])

  const update = (sha: string, patch: Partial<RebaseStep>): void =>
    setSteps((current) =>
      current.map((step) => (step.sha === sha ? { ...step, ...patch } : step))
    )

  const kept = steps.filter((step) => step.action !== 'drop')
  const resulting = steps.filter((step) => step.action === 'pick').length
  const canApply = kept.length > 0 && !rebasing

  return (
    <div className="modal-backdrop" onClick={() => openRebase(null)}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <h2>Rebase {run?.branchName}</h2>
        <p className="modal-copy">
          Oldest first, as in <code>git rebase -i</code>. A <code>squash</code> folds into the
          nearest <code>pick</code> above it. Only the message of a <code>pick</code> is used.
        </p>

        <div className="rebase-list">
          {steps.map((step, index) => (
            <div key={step.sha} className={`rebase-row rebase-${step.action}`}>
              <code className="rebase-sha">{step.sha.slice(0, 8)}</code>
              <select
                value={step.action}
                title={ACTIONS.find((a) => a.value === step.action)?.hint}
                onChange={(e) => update(step.sha, { action: e.target.value as RebaseAction })}
              >
                {ACTIONS.map((action) => (
                  <option
                    key={action.value}
                    value={action.value}
                    // Nothing precedes the first commit to fold into.
                    disabled={action.value === 'squash' && index === 0}
                  >
                    {action.label}
                  </option>
                ))}
              </select>
              <input
                value={step.message}
                disabled={step.action !== 'pick'}
                placeholder={step.action === 'drop' ? 'Dropped' : 'Folded into the commit above'}
                onChange={(e) => update(step.sha, { message: e.target.value })}
              />
            </div>
          ))}
        </div>

        {error && <p className="review-error">{error}</p>}

        <div className="modal-actions">
          <span className="review-pending">
            {kept.length === 0
              ? 'Keep at least one commit'
              : `${steps.length} commits become ${Math.max(resulting, 1)}`}
          </span>
          <div>
            <button className="ghost-btn" onClick={() => openRebase(null)}>
              Cancel
            </button>
            <button
              className="primary-btn"
              disabled={!canApply}
              onClick={() => void rebaseRun(runId, steps)}
            >
              {rebasing ? 'Rebasing…' : 'Rebase'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
