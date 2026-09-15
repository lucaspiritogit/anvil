import type { Task, TaskCheckoutMode } from './types'

export const TASK_CHECKOUT_MODES: readonly TaskCheckoutMode[] = ['worktree', 'local']

export function taskCheckoutMode(task: Pick<Task, 'checkoutMode'>): TaskCheckoutMode {
  return task.checkoutMode ?? 'worktree'
}
