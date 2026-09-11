import { useState } from 'react'
import type { Task } from '@shared/types'
import { useStore } from '../state/store'
import { btn } from '../ui'

export function TaskStackStatus({ task }: { task: Task }) {
  const tasks = useStore((state) => state.tasks)
  const openTask = useStore((state) => state.openTask)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const parent = tasks.find((entry) => entry.id === (task.restackTarget?.parentTaskId ?? task.parentTaskId))
  const suggestion = task.stackSuggestion
  const suggested = tasks.find((entry) => entry.id === suggestion?.parentTaskId)
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try { await action() } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  if (!parent && !task.restackState && !suggested) return null
  return <div className="shrink-0 border-b border-line px-5 py-2 text-xs space-y-2">
    {parent && <button className="text-accent hover:underline" onClick={() => openTask(parent.id)}>Stacked on {parent.title}</button>}
    {task.restackState && <div role="status">
      <span className="text-warn">{task.restackState === 'pending' ? 'Restack pending. Changes will apply after the current turn.' : 'Restack conflict'}</span>
      {task.restackState === 'conflict' && <>
        <p className="whitespace-pre-wrap text-dim">{task.deliveryError}</p>
        <button className={btn.ghost} disabled={busy || task.status === 'running'} onClick={() => void run(() => window.anvil.tasks.restack(task.id))}>Retry restack</button>
        <button className={btn.ghost} disabled={busy || task.status === 'running'} onClick={() => void run(() => window.anvil.tasks.rebaseWithAgent(task.id))}>Resolve with agent</button>
      </>}
    </div>}
    {suggestion && suggested && !task.restackState && <div>
      <p>This task expects to modify files also touched by {suggested.title}: {suggestion.paths.slice(0, 5).join(', ')}{suggestion.paths.length > 5 ? ` and ${suggestion.paths.length - 5} more` : ''}. Stack on it?</p>
      <button className={btn.ghost} disabled={busy} onClick={() => void run(() => window.anvil.tasks.stack({ taskId: task.id, parentTaskId: suggested.id }))}>Stack</button>
      <button className={btn.ghost} disabled={busy} onClick={() => void run(() => window.anvil.tasks.dismissStack(task.id))}>Dismiss</button>
    </div>}
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>
}
