import type { JSX } from 'react'
import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { btn, cn, modal } from '../ui'

/**
 * Confirms handing a branch to the agent. Agent mode gives up per-commit
 * control, so it asks once — until the developer says not to, which is stored
 * in settings rather than for the session only.
 */
export function AgentRebaseModal({ taskId }: { taskId: string }): JSX.Element {
  const openRebase = useStore((s) => s.openRebase)
  const rebaseWithAgent = useStore((s) => s.rebaseWithAgent)
  const saveSettings = useStore((s) => s.saveSettings)
  const task = useStore((s) => s.tasks.find((item) => item.id === taskId))

  const [dontAskAgain, setDontAskAgain] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (useStore.getState().settingsOpen) return
      if (e.key === 'Escape') openRebase(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openRebase])

  const confirm = async (): Promise<void> => {
    if (dontAskAgain) await saveSettings({ confirmRebase: false })
    await rebaseWithAgent(taskId)
  }

  return (
    <div className={modal.backdrop} onClick={() => openRebase(null)}>
      <div
        className={cn(modal.panel, modal.width.narrow)}
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className={modal.title}>Are you sure?</h2>
        <p className={modal.copy}>
          {task?.agentLabel ?? 'The agent'} will rebase{' '}
          <code className="font-mono text-fg">{task?.branchName}</code> into a single commit and
          write its message. Every change is kept; only the commit history of this task changes.
        </p>

        <label className={modal.toggle}>
          <input
            className="mt-0.5"
            type="checkbox"
            checked={dontAskAgain}
            onChange={(event) => setDontAskAgain(event.target.checked)}
          />
          <span className="block">
            <strong className="block">Don&apos;t ask again</strong>
            <small className="block mt-1 text-dim leading-[1.4]">
              Hand it straight to the agent from now on. Change this back in Settings.
            </small>
          </span>
        </label>

        <div className={modal.actions}>
          <div />
          <div className="flex gap-2">
            <button className={btn.ghost} onClick={() => openRebase(null)}>
              Cancel
            </button>
            <button className={btn.primary} onClick={() => void confirm()}>
              Rebase
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
