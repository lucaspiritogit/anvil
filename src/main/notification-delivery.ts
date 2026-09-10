import type { NotificationConstructorOptions } from 'electron'

export type NotificationAuthorization = 'not-determined' | 'granted' | 'denied' | 'provisional' | 'unknown'

interface NativeNotification {
  show(): void
  close(): void
  once(event: 'failed', listener: (event: Electron.Event, error: string) => void): unknown
  once(event: 'close', listener: () => void): unknown
  removeAllListeners(): unknown
}

export interface NotificationApi {
  new (options: NotificationConstructorOptions): NativeNotification
  isSupported(): boolean
}

export interface NotificationDeliveryOptions {
  authorize?: () => Promise<NotificationAuthorization>
  onUnavailable?: (reason: string) => void | Promise<void>
}

export function createNotificationDelivery(NotificationClass: NotificationApi, options: NotificationDeliveryOptions = {}) {
  const active = new Set<NativeNotification>()
  let disposed = false
  let authorization: Promise<NotificationAuthorization> | undefined
  let reportedUnavailable = false

  const failed = (error: unknown): void => {
    console.warn('Could not show task notification:', error)
    if (disposed || reportedUnavailable || !options.onUnavailable) return
    reportedUnavailable = true
    try {
      void Promise.resolve(options.onUnavailable(String(error))).catch((error) => {
        console.warn('Could not open notification recovery:', error)
      })
    } catch (error) {
      console.warn('Could not open notification recovery:', error)
    }
  }

  const release = (notification: NativeNotification): void => {
    active.delete(notification)
    notification.removeAllListeners()
  }

  const show = (content: NotificationConstructorOptions): void => {
    if (disposed) return
    let notification: NativeNotification | undefined
    try {
      // Electron 44's support check creates its presenter and requests macOS
      // authorization. Only touch it after our first-use authorization completes.
      if (!NotificationClass.isSupported()) return
      // Bound retained native objects, including banners never dismissed by the user.
      if (active.size >= 100) {
        const oldest = active.values().next().value!
        release(oldest)
        oldest.close()
      }
      notification = new NotificationClass(content)
      const current = notification
      active.add(current)
      current.once('failed', (_event, error) => {
        release(current)
        failed(error)
      })
      current.once('close', () => release(current))
      current.show()
    } catch (error) {
      if (notification) release(notification)
      failed(error)
    }
  }

  return {
    send(content: NotificationConstructorOptions): void {
      if (disposed) return
      try {
        if (!options.authorize) {
          show(content)
          return
        }
        // Share the first-use prompt. Query again for later events so Settings changes
        // take effect, but never replay denied events or retry them on unrelated activity.
        authorization ??= options.authorize().finally(() => { authorization = undefined })
        void authorization.then((status) => {
          if (disposed) return
          if (status === 'granted' || status === 'provisional') show(content)
          else failed(`Notification authorization: ${status}`)
        }).catch(failed)
      } catch (error) {
        failed(error)
      }
    },
    dispose(): void {
      disposed = true
      for (const notification of active) {
        release(notification)
        try { notification.close() } catch (error) { console.warn('Could not close notification:', error) }
      }
    }
  }
}
