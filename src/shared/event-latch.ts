export interface EventLatch<T> {
  /** Records a value and notifies current subscribers. */
  deliver: (value: T) => void
  /** Subscribes to values, replaying the latest delivered value once if one exists. */
  subscribe: (handler: (value: T) => void) => () => void
}

/**
 * Buffers the latest delivered value so a subscriber that arrives after the
 * event still observes it exactly once. Later deliveries keep reaching active
 * subscribers, matching the preload settings buffering semantics.
 */
export function createEventLatch<T>(): EventLatch<T> {
  let hasValue = false
  let latest: T
  const handlers = new Set<(value: T) => void>()

  return {
    deliver(value) {
      hasValue = true
      latest = value
      for (const handler of [...handlers]) handler(value)
    },
    subscribe(handler) {
      handlers.add(handler)
      if (hasValue) handler(latest)
      return () => { handlers.delete(handler) }
    }
  }
}
