import type { powerSaveBlocker } from 'electron'
import type { Store } from '../../server/store'

/** One blocker covers all running tasks, including preparation and gaps between agent turns. */
export function registerCaffeineMode(
  store: Pick<Store, 'getSettings' | 'getOpenedWorkspaces' | 'hasRunningTasks' | 'subscribeActivity'>,
  blocker: Pick<typeof powerSaveBlocker, 'start' | 'stop'>
): () => void {
  let blockerId: number | undefined
  const stop = (): void => {
    if (blockerId === undefined) return
    blocker.stop(blockerId)
    blockerId = undefined
  }
  const sync = (): void => {
    try {
      if (store.getOpenedWorkspaces().some((workspace) => store.getSettings(workspace.id).caffeineMode && store.hasRunningTasks(workspace.id))) {
        if (blockerId === undefined) blockerId = blocker.start('prevent-display-sleep')
      } else {
        stop()
      }
    } catch (error) {
      console.warn('Could not update caffeine mode:', error)
    }
  }
  const unsubscribe = store.subscribeActivity(sync)
  sync()
  return () => {
    unsubscribe()
    stop()
  }
}
