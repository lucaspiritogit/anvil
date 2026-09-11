import type { Task, TaskExecutionState } from './types'

export type TaskWorkingTime = Pick<Task, 'workingTimeMs' | 'workingStartedAt'>

/** Execution completion describes the issue plan; a running follow-up can still work. */
export function isTaskWorking(task: Pick<Task, 'status' | 'deliveryStatus'>, execution?: TaskExecutionState): boolean {
  if (task.status !== 'running' || !['working', 'unavailable'].includes(task.deliveryStatus)) return false
  if (execution?.phase === 'reviewing' || execution?.phase === 'blocked') return false
  // Between claimed issues the scheduler may retain running/working task state.
  return execution?.phase !== 'working' || Boolean(execution.currentIssueId)
}

/** Missing legacy measurements are zero, never inferred from task creation time. */
export function taskWorkingTimeMs(timing: TaskWorkingTime, now: number): number {
  return Math.max(0, timing.workingTimeMs ?? 0) +
    (timing.workingStartedAt === undefined ? 0 : Math.max(0, now - timing.workingStartedAt))
}

/** Checkpoint the measured interval on each write, then open only effective work. */
export function advanceTaskWorkingTime(timing: TaskWorkingTime, working: boolean, now: number): TaskWorkingTime {
  return {
    workingTimeMs: taskWorkingTimeMs(timing, now),
    workingStartedAt: working ? Math.max(now, timing.workingStartedAt ?? now) : undefined
  }
}
