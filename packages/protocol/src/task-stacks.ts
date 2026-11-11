import type { Task } from './types'
import { taskCheckoutMode } from './task-checkout'

export function isQueuedStackTask(task: Task): boolean {
  return Boolean(taskCheckoutMode(task) === 'worktree' && task.parentTaskId && task.status === 'running' &&
    task.deliveryStatus === 'preparing' && !task.branchName && !task.sessionId)
}

export function canStackOnTask(task: Task): boolean {
  if (taskCheckoutMode(task) !== 'worktree') return false
  if (task.status === 'cancelled' || task.settledAt !== undefined || task.restackState) return false
  if (isQueuedStackTask(task)) return true
  return Boolean(task.branchName && ['working', 'finalizing', 'did_not_commit', 'reviewable'].includes(task.deliveryStatus))
}
