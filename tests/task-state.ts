import { openTracker } from 'valence'
import type { Store } from '../src/main/store'

/** Read both clients' public interfaces without querying either database directly. */
export function taskState(store: Store, taskId: string) {
  const state = store.getTaskExecution(taskId)
  if (!state) return undefined
  const tracker = openTracker(state.projectPath)
  try {
    return { ...state, items: state.issueIds.map((id) => tracker.get(id)) }
  } finally {
    tracker.close()
  }
}
