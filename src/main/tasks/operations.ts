import type { Task } from '../../shared/types'
import type { Store } from '../store'

export type TaskOperation = 'steer' | 'review' | 'rebase' | 'merge' | 'pull-request' | 'draft'

interface Reservation { operation: TaskOperation; cancelled: boolean }
const reservations = new WeakMap<Store, Map<string, Reservation>>()

function operations(store: Store): Map<string, Reservation> {
  let entries = reservations.get(store)
  if (!entries) reservations.set(store, entries = new Map())
  return entries
}

/** Cancellation invalidates in-flight work without allowing a second operation until it unwinds. */
export function cancelTaskOperation(store: Store, taskId: string): boolean {
  const reservation = operations(store).get(taskId)
  if (!reservation) return false
  reservation.cancelled = true
  return true
}

/** All user task mutations conflict. Draft edits remain available during dispatch. */
export async function withTaskOperation<T>(
  store: Store, taskId: string, operation: TaskOperation,
  action: (check: (expected?: Task) => Task) => Promise<T>
): Promise<T> {
  const entries = operations(store)
  const active = entries.get(taskId)
  if (active) throw new Error(active.operation === 'steer'
    ? 'A message is already being sent to this task'
    : `This task is already busy with ${active.operation}`)
  const original = store.getTask(taskId)
  if (!original) throw new Error('Task not found')
  const projectPath = store.getProjects().find((project) => project.id === original.projectId)?.path
  const reservation = { operation, cancelled: false }
  entries.set(taskId, reservation)
  const check = (expected = original): Task => {
    const task = store.getTask(taskId)
    if (!task) throw new Error('Task was deleted')
    if (reservation.cancelled) throw new Error('Task operation was cancelled')
    // Session and usage updates may arrive while waiting. Identity and lifecycle must stay put.
    const keys = ['workspaceId', 'startedAt', 'projectId', 'agentId', 'branchName', 'baseCommit', 'headCommit',
      'status', 'deliveryStatus', 'settledAt', 'cwd'] as const
    if (keys.some((key) => task[key] !== expected[key]) ||
      store.getProjects().find((project) => project.id === task.projectId)?.path !== projectPath) {
      throw new Error('Task changed while the operation was waiting. Try again.')
    }
    return task
  }
  try {
    return await action(check)
  } finally {
    entries.delete(taskId)
  }
}
