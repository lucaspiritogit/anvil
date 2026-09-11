import type { JSX } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../state/store'
import { btn, cn, field, modal } from '../ui'
import type { RebaseAction, RebaseStep, TaskCommit } from '@shared/types'

const ACTIONS: { value: RebaseAction; label: string; hint: string }[] = [
  { value: 'pick', label: 'pick', hint: 'Keep as its own commit' },
  { value: 'squash', label: 'squash', hint: 'Fold into the commit above' },
  { value: 'drop', label: 'drop', hint: 'Discard this commit entirely' }
]

/** A dropped commit is struck through; a squashed one points at what it folds into. */
const SHA_TONE: Record<RebaseAction, string> = {
  pick: 'text-dim',
  squash: 'text-accent',
  drop: 'text-danger line-through'
}

const CONTROL = 'px-2 py-[5px] text-xs'

/**
 * A small interactive rebase. Commits are listed oldest first, the way
 * `git rebase -i` writes its todo list, so "squash" folding upward reads the
 * same as it does in git.
 */
export function RebaseModal({ taskId, commits }: { taskId: string; commits: TaskCommit[] }): JSX.Element {
  const openRebase = useStore((s) => s.openRebase)
  const rebaseTask = useStore((s) => s.rebaseTask)
  const rebasing = useStore((s) => s.rebasing === taskId)
  const task = useStore((s) => s.tasks.find((item) => item.id === taskId))
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
      if (useStore.getState().settingsOpen) return
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
    <div className={modal.backdrop} onClick={() => openRebase(null)}>
      <div
        className={cn(modal.panel, modal.width.wide)}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className={modal.title}>Rebase {task?.branchName}</h2>
        <p className={modal.copy}>
          Oldest first, as in <code className="font-mono text-fg">git rebase -i</code>. A{' '}
          <code className="font-mono text-fg">squash</code> folds into the nearest{' '}
          <code className="font-mono text-fg">pick</code> above it. Only the message of a{' '}
          <code className="font-mono text-fg">pick</code> is used.
        </p>

        <div className="flex flex-col gap-1.5 max-h-[46vh] p-2.5 overflow-y-auto bg-canvas border border-line">
          {steps.map((step, index) => (
            <div
              key={step.sha}
              className={cn(
                'grid grid-cols-[72px_96px_1fr] gap-2 items-center',
                step.action === 'drop' && 'opacity-55'
              )}
            >
              <code className={cn('font-mono text-xs', SHA_TONE[step.action])}>
                {step.sha.slice(0, 8)}
              </code>
              <select
                className={cn(field.control, CONTROL)}
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
                className={cn(field.control, CONTROL, 'disabled:text-dim disabled:bg-raised')}
                value={step.message}
                disabled={step.action !== 'pick'}
                placeholder={step.action === 'drop' ? 'Dropped' : 'Folded into the commit above'}
                onChange={(e) => update(step.sha, { message: e.target.value })}
              />
            </div>
          ))}
        </div>

        {error && <p className="mt-2 text-xs text-danger">{error}</p>}

        <div className={modal.actions}>
          <span className="text-xs text-dim">
            {kept.length === 0
              ? 'Keep at least one commit'
              : `${steps.length} commits become ${Math.max(resulting, 1)}`}
          </span>
          <div className="flex gap-2">
            <button className={btn.ghost} onClick={() => openRebase(null)}>
              Cancel
            </button>
            <button
              className={btn.primary}
              disabled={!canApply}
              onClick={() => void rebaseTask(taskId, steps)}
            >
              {rebasing ? 'Rebasing…' : 'Rebase'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
