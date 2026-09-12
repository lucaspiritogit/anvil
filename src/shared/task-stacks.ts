import type { Task } from './types'

export function isQueuedStackTask(task: Task): boolean {
  return Boolean(task.parentTaskId && task.status === 'running' &&
    task.deliveryStatus === 'preparing' && !task.branchName && !task.sessionId)
}

export function canStackOnTask(task: Task): boolean {
  if (task.status === 'cancelled' || task.settledAt !== undefined || task.restackState) return false
  if (isQueuedStackTask(task)) return true
  return Boolean(task.branchName && ['working', 'finalizing', 'did_not_commit', 'reviewable'].includes(task.deliveryStatus))
}
