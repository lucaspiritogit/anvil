import type { powerSaveBlocker } from 'electron'
import type { CaffeineActivity } from '../../shared/caffeine'

/** One blocker covers all running tasks, including preparation and gaps between agent turns. */
export function registerCaffeineMode(
  activity: CaffeineActivity,
  blocker: Pick<typeof powerSaveBlocker, 'start' | 'stop'>
): () => void {
  let blockerId: number | undefined
  const stop = (): void => {
    if (blockerId === undefined) return
    blocker.stop(blockerId)
    blockerId = undefined
  }
  const unsubscribe = activity.subscribe(({ keepAwake }) => {
    try {
      if (keepAwake) {
        if (blockerId === undefined) blockerId = blocker.start('prevent-display-sleep')
      } else {
        stop()
      }
    } catch (error) {
      console.warn('Could not update caffeine mode:', error)
    }
  })
  return () => {
    unsubscribe()
    stop()
  }
}
