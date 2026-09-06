import type { Task } from './types'

export const TASK_SETTLE_TTL_MS = 4 * 60 * 60 * 1000

/** No-change tasks need no code review. Everything else must be approved first. */
export function canSettleTask(task: Task): boolean {
  return task.status === 'succeeded' &&
    (task.deliveryStatus === 'approved' || task.deliveryStatus === 'no_changes') &&
    task.settledAt === undefined
}

export function settlementDeadline(task: Task): number | undefined {
  if (!canSettleTask(task)) return undefined
  // Older approved tasks predate reviewedAt, so use their completion time.
  const eligibleAt = task.deliveryStatus === 'approved' ? task.reviewedAt ?? task.endedAt : task.endedAt
  return eligibleAt === undefined ? undefined : eligibleAt + TASK_SETTLE_TTL_MS
}
