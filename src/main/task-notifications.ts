import { createNotificationDelivery, type NotificationApi, type NotificationDeliveryOptions } from './notification-delivery'
import type { Task, TaskStatus } from '../shared/types'
import type { Issue } from '../shared/valence'
import type { Store } from './store'

const statusTitles: Record<TaskStatus, string> = {
  pending: 'Task pending',
  running: 'Task running',
  succeeded: 'Task completed',
  failed: 'Task failed',
  cancelled: 'Task cancelled'
}

interface Snapshot {
  task: Task
  currentIssueId: string | null
  issues: Issue[]
}

/** Observe committed state independently of renderer windows and workspace selection. */
export function registerTaskNotifications(
  store: Pick<Store, 'getTasks' | 'subscribeActivity' | 'getTaskExecution' | 'issueTracker'>,
  NotificationClass: NotificationApi,
  options: NotificationDeliveryOptions = {}
): () => void {
  const snapshot = (): Map<string, Snapshot> => new Map(store.getTasks().map((task) => {
    const state = store.getTaskExecution(task.id)
    let issues: Issue[] = []
    if (state) {
      const tracker = store.issueTracker(task.projectId, task.workspaceId)
      try { issues = tracker.list(state.parentIssueId) } finally { tracker.close() }
    }
    return [JSON.stringify([task.workspaceId, task.id]), { task, currentIssueId: state?.currentIssueId ?? null, issues }]
  }))
  let previous = snapshot()
  const delivery = createNotificationDelivery(NotificationClass, options)

  const unsubscribe = store.subscribeActivity(() => {
    const next = snapshot()
    const baseline = previous
    // Advance before delivery, even if authorization is pending or delivery fails.
    previous = next
    for (const [key, current] of next) {
      const before = baseline.get(key)
      if (!before) continue
      const { task, issues } = current
      const oldIssues = new Map(before.issues.map((issue) => [issue.id, issue]))
      const active = oldIssues.get(before.currentIssueId ?? '')
      const cancelled = task.status === 'cancelled' && before.task.status !== 'cancelled' &&
        active && (active.status === 'working' || active.status === 'review') ? active : undefined
      const sendIssue = (issue: Issue, status: string): void => {
        delivery.send({ title: `Subtask ${status}: ${issue.title}`, body: `${task.title} · ${issue.id}` })
      }
      if (cancelled) sendIssue(cancelled, 'cancelled')
      for (const issue of issues) {
        const old = oldIssues.get(issue.id)
        if (!old || old.status === issue.status || cancelled?.id === issue.id) continue
        if (issue.status === 'review') sendIssue(issue, 'ready for review')
        if (issue.status === 'blocked') sendIssue(issue, 'blocked')
      }
      // A failed turn pauses its parent after blocking the issue. Keep that one
      // subtask alert, while retaining unrelated parent lifecycle notifications.
      const blocked = issues.some((issue) => issue.id === current.currentIssueId && issue.status === 'blocked')
      const parentPause = blocked && before.task.status === 'running' &&
        (task.status === 'pending' || task.status === 'failed')
      if (before.task.status !== task.status && !cancelled && !parentPause) {
        delivery.send({ title: statusTitles[task.status], body: task.title })
      }
    }
  })
  return () => {
    unsubscribe()
    delivery.dispose()
  }
}
