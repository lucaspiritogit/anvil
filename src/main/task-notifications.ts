import { createNotificationDelivery, type NotificationApi, type NotificationDeliveryOptions } from './notification-delivery'
import type { TaskStatus } from '../shared/types'
import type { Store } from './store'

const statusTitles: Record<TaskStatus, string> = {
  pending: 'Task pending',
  running: 'Task running',
  succeeded: 'Task completed',
  failed: 'Task failed',
  cancelled: 'Task cancelled'
}

/** Observe persisted status changes independently of renderer windows and task output. */
export function registerTaskNotifications(
  store: Pick<Store, 'getTasks' | 'subscribeActivity'>,
  NotificationClass: NotificationApi,
  options: NotificationDeliveryOptions = {}
): () => void {
  let statuses = new Map(store.getTasks().map((task) => [task.id, task.status]))
  const delivery = createNotificationDelivery(NotificationClass, options)

  const unsubscribe = store.subscribeActivity(() => {
    const tasks = store.getTasks()
    const previousStatuses = statuses
    // Save the state before showing notifications, including when delivery fails.
    statuses = new Map(tasks.map((task) => [task.id, task.status]))

    for (const task of tasks) {
      const previousStatus = previousStatuses.get(task.id)
      // Newly loaded or created tasks establish a baseline without replaying history.
      if (previousStatus === undefined || previousStatus === task.status) continue

      delivery.send({ title: statusTitles[task.status], body: task.title })
    }
  })
  return () => {
    unsubscribe()
    delivery.dispose()
  }
}
