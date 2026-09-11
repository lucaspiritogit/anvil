import type { Task } from './types'

export const TASK_SETTLE_TTL_MS = 2 * 24 * 60 * 60 * 1000

/** A task is settled once it has been reviewed and closed (succeeded tasks only). */
export function isTaskSettled(task: Task): boolean {
  return task.settledAt !== undefined
}

/** No-change tasks need no code review. Everything else must be approved first. */
export function canSettleTask(task: Task): boolean {
  return !task.restackState && !task.parentTaskId && task.status === 'succeeded' &&
    (task.deliveryStatus === 'approved' || task.deliveryStatus === 'no_changes') &&
    task.settledAt === undefined
}

export function settlementDeadline(task: Task): number | undefined {
  if (!canSettleTask(task)) return undefined
  // Older approved tasks predate reviewedAt, so use their completion time.
  const eligibleAt = task.deliveryStatus === 'approved' ? task.reviewedAt ?? task.endedAt : task.endedAt
  return eligibleAt === undefined ? undefined : eligibleAt + TASK_SETTLE_TTL_MS
}
