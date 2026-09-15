import type { Task } from '../../shared/types'
import { taskCheckoutMode } from '../../shared/task-checkout'
import type { Store } from '../store'

export function usesProjectCheckout(task: Task): boolean {
  return taskCheckoutMode(task) === 'local' ||
    !task.branchName && task.deliveryStatus === 'unavailable'
}

export function usesManagedWorktree(task: Task): boolean {
  return taskCheckoutMode(task) === 'worktree'
}

export function requireProjectCheckoutAvailable(store: Store, task: Task, force = false): void {
  if (!force && !usesProjectCheckout(task)) return
  if (store.getTasks(task.workspaceId).some((candidate) => candidate.id !== task.id &&
    candidate.projectId === task.projectId &&
    (candidate.deliveryStatus === 'merge_conflict' || candidate.mergeConflict))) {
    throw new Error('Resolve or abort the paused task merge before using this project checkout')
  }
}
