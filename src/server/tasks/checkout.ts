import type { Task } from '../../shared/types'
import { taskCheckoutMode } from '../../shared/task-checkout'
import { taskStyle } from '../../shared/task-style'
import type { Store } from '../store'

export function usesProjectCheckout(task: Task): boolean {
  return taskStyle(task) === 'quick' || taskCheckoutMode(task) === 'local' ||
    !task.branchName && task.deliveryStatus === 'unavailable'
}

export function usesManagedWorktree(task: Task): boolean {
  return taskStyle(task) === 'work' && taskCheckoutMode(task) === 'worktree'
}

export function requireProjectCheckoutAvailable(store: Store, task: Task, force = false): void {
  if (!force && !usesProjectCheckout(task)) return
  const conflict = store.getTasks(task.workspaceId).find((candidate) => candidate.id !== task.id &&
    candidate.projectId === task.projectId && candidate.status === 'running' && (force || usesProjectCheckout(candidate)))
  if (conflict) {
    if (taskStyle(task) === 'quick' && taskStyle(conflict) === 'quick') throw new Error('Wait for the active Quick task in this project to finish')
    throw new Error('Wait for the active task using this project checkout to finish')
  }
}
