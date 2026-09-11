import type { CaffeineActivity, CaffeineState } from '../shared/caffeine'
import type { Store } from './store'

/** The server reports whether task owners want sleep prevention; the desktop applies it. */
export function createCaffeineActivity(
  store: Pick<Store, 'getSettings' | 'getOpenedWorkspaces' | 'hasRunningTasks' | 'subscribeActivity'>
): CaffeineActivity & { snapshot(): CaffeineState } {
  const snapshot = (): CaffeineState => ({
    keepAwake: store.getOpenedWorkspaces().some((workspace) =>
      store.getSettings(workspace.id).caffeineMode && store.hasRunningTasks(workspace.id))
  })
  return {
    snapshot,
    subscribe(listener) {
      let previous: boolean | undefined
      const sync = (): void => {
        const state = snapshot()
        if (state.keepAwake === previous) return
        previous = state.keepAwake
        listener(state)
      }
      const unsubscribe = store.subscribeActivity(sync)
      sync()
      return unsubscribe
    }
  }
}
