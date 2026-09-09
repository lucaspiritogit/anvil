import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { TaskIssueSnapshot } from '@shared/types'
import { useStore } from '../state/store'
import { createTaskIssuesCache, selectedTaskIssue } from '../state/task-issues'

// Lazy source callbacks keep this singleton safe to import before preload is available.
const taskIssues = createTaskIssuesCache({
  read: (id) => window.anvil.tasks.issues(id),
  onUpdated: (refresh) => window.anvil.tasks.onUpdated((task) => refresh(task.id)),
  onFocus: (refresh) => {
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  },
  onDeleted: (remove) => useStore.subscribe((state, previous) => {
    if (state.tasks === previous.tasks) return
    const ids = new Set(state.tasks.map((task) => task.id))
    for (const task of previous.tasks) {
      if (!ids.has(task.id)) remove(task.id)
    }
  })
})

const inactive = { taskId: null, snapshot: null, loading: false, empty: false, missing: false, error: null }

/** Sidebar, task view and Issues panel observe the same owning-task snapshot. */
export function useTaskIssues(taskId: string, enabled: boolean, selectedIssueId: string | null = null) {
  const exists = useStore((state) => state.tasks.some((task) => task.id === taskId))
  const active = enabled && exists
  const subscribe = useCallback((listener: () => void) => active
    ? taskIssues.subscribe(taskId, listener)
    : () => {}, [taskId, active])
  const getSnapshot = useCallback(() => active ? taskIssues.getSnapshot(taskId) : inactive, [taskId, active])
  const state = useSyncExternalStore(subscribe, getSnapshot)
  const refresh = useCallback(() => taskIssues.refresh(taskId), [taskId])
  return { ...state, selectedIssue: selectedTaskIssue(state.snapshot, selectedIssueId), refresh }
}

/** Observe every sidebar owner, including filtered and collapsed settled tasks. */
export function useSidebarIssueSnapshots() {
  const tasks = useStore((state) => state.tasks)
  const subscriptions = useRef(new Map<string, () => void>())
  const [snapshots, setSnapshots] = useState(new Map<string, TaskIssueSnapshot | null>())

  useEffect(() => {
    const ids = new Set(tasks.map((task) => task.id))
    for (const [id, unsubscribe] of subscriptions.current) {
      if (!ids.has(id)) {
        unsubscribe()
        subscriptions.current.delete(id)
      }
    }
    setSnapshots((previous) => new Map([...previous].filter(([id]) => ids.has(id))))
    for (const id of ids) {
      if (subscriptions.current.has(id)) continue
      const update = (): void => {
        const snapshot = taskIssues.getSnapshot(id).snapshot
        setSnapshots((previous) => previous.get(id) === snapshot ? previous : new Map(previous).set(id, snapshot))
      }
      subscriptions.current.set(id, taskIssues.subscribe(id, update))
      update()
    }
  }, [tasks])

  useEffect(() => () => {
    subscriptions.current.forEach((unsubscribe) => unsubscribe())
    subscriptions.current.clear()
  }, [])
  return snapshots
}
