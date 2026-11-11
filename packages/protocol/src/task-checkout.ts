import type { Task, TaskCheckoutMode, TaskExecutionState } from './types'

export const TASK_CHECKOUT_MODES: readonly TaskCheckoutMode[] = ['worktree', 'local']

export function taskCheckoutMode(task: Pick<Task, 'checkoutMode'>): TaskCheckoutMode {
  return task.checkoutMode ?? 'worktree'
}

export function isLocalTask(task: Pick<Task, 'checkoutMode'>): boolean {
  return taskCheckoutMode(task) === 'local'
}

export function hasIssuePlan(state: Pick<TaskExecutionState, 'parentIssueId'>): boolean {
  return state.parentIssueId !== ''
}

export function hasRunningTaskDiff(task: Pick<Task, 'checkoutMode' | 'status' | 'reviewPaths' | 'baseCommit' | 'headCommit' | 'filesChanged'>): boolean {
  if (task.status !== 'running') return false
  if (isLocalTask(task)) return Boolean(task.reviewPaths?.length)
  return Boolean(task.baseCommit && task.headCommit && task.filesChanged > 0)
}
