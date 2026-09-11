import { createNotificationDelivery, type NotificationApi, type NotificationDeliveryOptions } from './notification-delivery'
import type { Task, TaskStatus } from '../../shared/types'
import type { Issue } from '../../shared/valence'
import type { Store } from '../../server/store'

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
  reviewReady: boolean
  completed: boolean
}

/** Observe committed state independently of renderer windows and workspace selection. */
export function registerTaskNotifications(
  store: Pick<Store, 'getTasks' | 'subscribeActivity' | 'getTaskExecution' | 'issueTracker'>,
  NotificationClass: NotificationApi,
  options: NotificationDeliveryOptions = {},
  issueReviewReady: (taskId: string) => boolean = (taskId) => store.getTaskExecution(taskId)?.phase === 'reviewing'
): () => void {
  const snapshot = (): Map<string, Snapshot> => new Map(store.getTasks().map((task) => {
    const state = store.getTaskExecution(task.id)
    let issues: Issue[] = []
    if (state) {
      const tracker = store.issueTracker(task.projectId, task.workspaceId)
      try { issues = tracker.list(state.parentIssueId) } finally { tracker.close() }
    }
    const completed = task.status === 'succeeded' && (!(task.baseCommit && task.branchName) ||
      ['reviewable', 'no_changes', 'approved'].includes(task.deliveryStatus))
    return [JSON.stringify([task.workspaceId, task.id]), {
      task, currentIssueId: state?.currentIssueId ?? null, issues,
      reviewReady: issueReviewReady(task.id), completed
    }]
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
        if (!old || cancelled?.id === issue.id) continue
        if (issue.status === 'review' && issue.id === current.currentIssueId && current.reviewReady &&
          (!before.reviewReady || before.currentIssueId !== issue.id || old.status !== 'review' || old.headCommit !== issue.headCommit)) {
          sendIssue(issue, 'ready for review')
        }
        if (issue.status === 'blocked' && old.status !== 'blocked') sendIssue(issue, 'blocked')
      }
      // A failed turn pauses its parent after blocking the issue. Keep that one
      // subtask alert, while retaining unrelated parent lifecycle notifications.
      const blocked = issues.some((issue) => issue.id === current.currentIssueId && issue.status === 'blocked')
      const parentPause = blocked && before.task.status === 'running' &&
        (task.status === 'pending' || task.status === 'failed')
      const parentChanged = task.status === 'succeeded'
        ? current.completed && !before.completed : before.task.status !== task.status
      if (parentChanged && !cancelled && !parentPause) {
        delivery.send({ title: statusTitles[task.status], body: task.title })
      }
    }
  })
  return () => {
    unsubscribe()
    delivery.dispose()
  }
}
