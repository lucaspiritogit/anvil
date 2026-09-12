import { useState } from 'react'
import { isQueuedStackTask } from '@shared/task-stacks'
import type { Task } from '@shared/types'
import { useStore } from '../state/store'
import { Icon } from '../icons'
import { RestackConflictAlert } from './RestackConflictAlert'

export function TaskStackStatus({ task }: { task: Task }) {
  const tasks = useStore((state) => state.tasks)
  const openTask = useStore((state) => state.openTask)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const parent = tasks.find((entry) => entry.id === (task.restackTarget?.parentTaskId ?? task.parentTaskId))
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try { await action() } catch (error) { setError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  if (!parent && !task.restackState) return null
  return <div className="shrink-0 border-b border-line px-5 py-2 text-xs space-y-2">
    {parent && <button className="inline-flex items-center gap-1.5 text-accent hover:underline" onClick={() => openTask(parent.id)}><Icon icon="layers" size={14} />Stacked on {parent.title}</button>}
    {parent && isQueuedStackTask(task) && <p role="status" className="text-dim">Queued. Waiting for {parent.title} to finish before starting.</p>}
    {task.restackState === 'pending' && <p role="status" className="text-warn">Restack pending. Waiting for the parent task to finish and the current turn to stop.</p>}
    {task.restackState === 'conflict' && <RestackConflictAlert
      error={task.deliveryError}
      disabled={busy || task.status === 'running'}
      onRetry={() => void run(() => window.anvil.tasks.restack(task.id))}
      onResolveWithAgent={() => void run(() => window.anvil.tasks.rebaseWithAgent(task.id))}
    />}
    {error && <p role="alert" className="text-danger">{error}</p>}
  </div>
}
