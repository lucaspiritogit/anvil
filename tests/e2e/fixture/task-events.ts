import { DEFAULT_TASK_EVENT_PAGE_SIZE, MAX_TASK_EVENT_PAGE_SIZE } from '../../../src/shared/types'
import type { TaskEvent, TaskEventsPage, TaskEventsRequest } from '../../../src/shared/types'

export function pageTaskEvents(history: TaskEvent[], input: TaskEventsRequest): TaskEventsPage {
  const rows = history.filter((event) => event.taskId === input.taskId)
    .map((event, index) => ({ ...event, sequence: event.sequence ?? index + 1 }))
    .sort((a, b) => a.sequence - b.sequence)
  const limit = Math.min(input.limit ?? DEFAULT_TASK_EVENT_PAGE_SIZE, MAX_TASK_EVENT_PAGE_SIZE)
  const matching = rows.filter((event) => (!input.before || event.sequence < input.before.sequence) &&
    (!input.after || event.sequence > input.after.sequence))
  const events = input.after ? matching.slice(0, limit) : matching.slice(-limit)
  const oldest = events[0]?.sequence ?? input.before?.sequence ?? input.after?.sequence
  const newest = events.at(-1)?.sequence ?? input.before?.sequence ?? input.after?.sequence
  return {
    events,
    oldestCursor: events.length ? { taskId: input.taskId, sequence: oldest! } : null,
    newestCursor: events.length ? { taskId: input.taskId, sequence: newest! } : null,
    hasOlder: rows.some((event) => oldest !== undefined && event.sequence < oldest),
    hasNewer: rows.some((event) => newest !== undefined && event.sequence > newest)
  }
}
