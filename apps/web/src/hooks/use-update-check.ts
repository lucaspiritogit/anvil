import { useEffect, useSyncExternalStore } from 'react'
import { createUpdateChecker, type UpdateChecker } from '../update-check'

let checker: UpdateChecker | null = null
let consumers = 0

export function getUpdateChecker(): UpdateChecker {
  checker ??= createUpdateChecker({
    enabled: !import.meta.env.DEV,
    check: (force) => window.anvil.app.serverUpdates.check(force),
    onChanged: (listener) => window.anvil.app.serverUpdates.onChanged(listener),
    isOnline: () => navigator.onLine,
    onFocus: (listener) => {
      const onVisibility = () => { if (document.visibilityState === 'visible') listener() }
      window.addEventListener('focus', listener)
      document.addEventListener('visibilitychange', onVisibility)
      return () => {
        window.removeEventListener('focus', listener)
        document.removeEventListener('visibilitychange', onVisibility)
      }
    },
    onOnline: (listener) => {
      window.addEventListener('online', listener)
      return () => window.removeEventListener('online', listener)
    }
  })
  return checker
}

export function useUpdateCheck() {
  const instance = getUpdateChecker()
  const state = useSyncExternalStore(instance.subscribe, instance.getSnapshot)
  useEffect(() => {
    consumers += 1
    if (consumers === 1) instance.start()
    return () => {
      consumers -= 1
      if (consumers === 0) instance.stop()
    }
  }, [instance])
  return { ...state, checkNow: instance.check }
}
