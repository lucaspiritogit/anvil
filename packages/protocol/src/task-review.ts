import type { Task } from './types'
import { taskStyle } from './task-style'

export function isTaskFinishedUnseen(task: Task, seenAt: number | undefined): boolean {
  if (task.status !== 'succeeded' || task.settledAt !== undefined) return false
  return (task.endedAt ?? task.startedAt) > (seenAt ?? 0)
}

export function taskNeedsReview(task: Task, seenAt: number | undefined): boolean {
  if (task.status !== 'succeeded' || task.settledAt !== undefined) return false
  if (task.deliveryStatus === 'reviewable') return true
  if (taskStyle(task) !== 'work' || task.deliveryStatus === 'no_changes') return isTaskFinishedUnseen(task, seenAt)
  return false
}

export function taskAttentionRank(task: Task, seenAt: number | undefined): number {
  if (taskNeedsReview(task, seenAt)) return 0
  if (task.status === 'running') return 1
  if (task.status === 'pending') return 2
  return 3
}
