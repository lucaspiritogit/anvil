import { useEffect, useSyncExternalStore } from 'react'
import { buildInfo } from '../build-info'
import { createUpdateChecker, type UpdateChecker } from '../update-check'

let checker: UpdateChecker | null = null
let consumers = 0

export function getUpdateChecker(): UpdateChecker {
  checker ??= createUpdateChecker({
    buildSha: buildInfo.updateChecksEnabled ? buildInfo.sha : null,
    enabled: buildInfo.updateChecksEnabled && !import.meta.env.DEV,
    fetch: (url, init) => window.fetch(url, { ...init, cache: 'no-cache' }),
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
