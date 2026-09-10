import type { NotificationConstructorOptions } from 'electron'
import type { TaskStatus } from '../shared/types'
import type { Store } from './store'

interface NotificationApi {
  new (options: NotificationConstructorOptions): {
    show(): void
    once(event: 'failed', listener: (event: Electron.Event, error: string) => void): unknown
  }
  isSupported(): boolean
}

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
  NotificationClass: NotificationApi
): () => void {
  let statuses = new Map(store.getTasks().map((task) => [task.id, task.status]))

  return store.subscribeActivity(() => {
    const tasks = store.getTasks()
    const previousStatuses = statuses
    // Save the state before showing notifications, including when delivery fails.
    statuses = new Map(tasks.map((task) => [task.id, task.status]))

    for (const task of tasks) {
      const previousStatus = previousStatuses.get(task.id)
      // Newly loaded or created tasks establish a baseline without replaying history.
      if (previousStatus === undefined || previousStatus === task.status) continue

      try {
        if (!NotificationClass.isSupported()) continue
        const notification = new NotificationClass({
          title: statusTitles[task.status],
          body: task.title
        })
        notification.once('failed', (_event, error) => {
          console.warn('Could not show task notification:', error)
        })
        notification.show()
      } catch (error) {
        console.warn('Could not show task notification:', error)
      }
    }
  })
}
