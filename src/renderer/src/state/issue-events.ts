import type { TaskEvent } from '../../../shared/types'

/** Live snapshots win over an older persisted read, including updates to tool events. */
export function mergeIssueEvents(taskId: string, issueId: string, saved: TaskEvent[], live: TaskEvent[]): TaskEvent[] {
  const scoped = [...saved, ...live].filter((event) => event.taskId === taskId && event.issueId === issueId)
  return [...new Map(scoped.map((event) => [event.id, event])).values()]
}

