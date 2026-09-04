import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStore } from '../state/store'

/**
 * Confirms handing a branch to the agent. Agent mode gives up per-commit
 * control, so it asks once — until the developer says not to, which is stored
 * in settings rather than for the session only.
 */
export function AgentRebaseModal({ runId }: { runId: string }): JSX.Element {
  const openRebase = useStore((s) => s.openRebase)
  const rebaseWithAgent = useStore((s) => s.rebaseWithAgent)
  const saveSettings = useStore((s) => s.saveSettings)
  const run = useStore((s) => s.runs.find((item) => item.id === runId))

  const [dontAskAgain, setDontAskAgain] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') openRebase(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openRebase])

  const confirm = async (): Promise<void> => {
    if (dontAskAgain) await saveSettings({ confirmRebase: false })
    await rebaseWithAgent(runId)
  }

  return (
    <div className="modal-backdrop" onClick={() => openRebase(null)}>
      <div className="modal modal-narrow" onClick={(e) => e.stopPropagation()}>
        <h2>Are you sure?</h2>
        <p className="modal-copy">
          {run?.agentLabel ?? 'The agent'} will rebase <code>{run?.branchName}</code> into a single
          commit and write its message. Every change is kept; only the commit history of this task
          changes.
        </p>

        <label className="toggle-field">
          <input
            type="checkbox"
            checked={dontAskAgain}
            onChange={(event) => setDontAskAgain(event.target.checked)}
          />
          <span>
            <strong>Don&apos;t ask again</strong>
            <small>Hand it straight to the agent from now on. Change this back in Settings.</small>
          </span>
        </label>

        <div className="modal-actions">
          <div />
          <div>
            <button className="ghost-btn" onClick={() => openRebase(null)}>
              Cancel
            </button>
            <button className="primary-btn" onClick={() => void confirm()}>
              Rebase
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
