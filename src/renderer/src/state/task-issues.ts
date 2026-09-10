import type { TaskIssueSnapshot } from '../../../shared/types'

export interface TaskIssuesState {
  taskId: string | null
  snapshot: TaskIssueSnapshot | null
  loading: boolean
  empty: boolean
  missing: boolean
  error: string | null
}

interface Source {
  onMissing?: (taskId: string) => void
  read: (taskId: string) => Promise<TaskIssueSnapshot | null>
  onUpdated: (refresh: (taskId: string) => void) => () => void
  onDeleted: (remove: (taskId: string) => void) => () => void
  onFocus: (refresh: () => void) => () => void
}

const initial = (taskId: string): TaskIssuesState => ({
  taskId, snapshot: null, loading: true, empty: false, missing: false, error: null
})

interface Entry {
  state: TaskIssuesState
  listeners: Set<() => void>
  generation: number
  busy: boolean
  pending: boolean
}

/** Shared by all renderer consumers. Only observed tasks poll, with at most four reads globally. */
export function createTaskIssuesCache(source: Source) {
  const entries = new Map<string, Entry>()
  let running = 0
  let cleanup: (() => void) | undefined
  const entryFor = (taskId: string): Entry => {
    let entry = entries.get(taskId)
    if (!entry) {
      entry = { state: initial(taskId), listeners: new Set(), generation: 0, busy: false, pending: false }
      entries.set(taskId, entry)
    }
    return entry
  }
  const publish = (entry: Entry, state: TaskIssuesState): void => {
    entry.state = state
    entry.listeners.forEach((listener) => listener())
  }
  const pump = (): void => {
    for (const [taskId, entry] of [...entries]) {
      if (running >= 4) break
      if (!entry.pending || entry.busy || !entry.listeners.size) continue
      // Move started reads behind waiting tasks so repeated refreshes cannot starve them.
      entries.delete(taskId)
      entries.set(taskId, entry)
      entry.pending = false
      entry.busy = true
      running++
      const generation = entry.generation
      void (async () => {
        try {
          const snapshot = await source.read(taskId)
          if (entry.listeners.size && generation === entry.generation) {
            publish(entry, { taskId, snapshot, loading: false, empty: snapshot !== null && snapshot.children.length === 0, missing: snapshot === null, error: null })
          }
        } catch (error) {
          if (entry.listeners.size && generation === entry.generation) {
            const message = error instanceof Error ? error.message : String(error)
            if (/(?:^|Error: )(?:Task not found|Parent issue not found(?:: [^\n]+)?)$/.test(message)) {
              publish(entry, { ...entry.state, snapshot: null, loading: false, missing: true, error: null })
              source.onMissing?.(taskId)
            } else {
              publish(entry, { ...entry.state, loading: false, error: message })
            }
          }
        } finally {
          entry.busy = false
          running--
          if (!entry.listeners.size && entries.get(taskId) === entry) entries.delete(taskId)
          pump()
        }
      })()
    }
  }
  const refresh = (taskId?: string): void => {
    for (const [id, entry] of entries) {
      if (entry.listeners.size && (taskId === undefined || taskId === id)) entry.pending = true
    }
    pump()
  }
  const stopIfUnused = (): void => {
    if ([...entries.values()].some((entry) => entry.listeners.size)) return
    cleanup?.()
    cleanup = undefined
  }
  return {
    getSnapshot: (taskId: string) => entryFor(taskId).state,
    refresh,
    subscribe(taskId: string, listener: () => void) {
      const entry = entryFor(taskId)
      // Each subscription owns its own token, even if callback identities match.
      const notify = (): void => listener()
      const first = entry.listeners.size === 0
      entry.listeners.add(notify)
      if (!cleanup) {
        const timer = setInterval(() => refresh(), 500)
        const offUpdate = source.onUpdated(refresh)
        const offFocus = source.onFocus(() => refresh())
        const offDelete = source.onDeleted((id) => {
          const deleted = entries.get(id)
          if (!deleted) return
          deleted.generation++
          deleted.pending = false
          publish(deleted, { ...initial(id), taskId: null, loading: false })
          deleted.listeners.clear()
          if (!deleted.busy) entries.delete(id)
          stopIfUnused()
        })
        cleanup = () => { clearInterval(timer); offUpdate(); offFocus(); offDelete() }
      }
      if (first) refresh(taskId)
      return () => {
        entry.listeners.delete(notify)
        if (!entry.listeners.size) {
          entry.generation++
          entry.pending = false
          if (!entry.busy && entries.get(taskId) === entry) entries.delete(taskId)
        }
        stopIfUnused()
      }
    }
  }
}

/** Keep only a selected ID in the panel so details always use the latest read. */
export function selectedTaskIssue(snapshot: TaskIssueSnapshot | null, issueId: string | null) {
  if (!snapshot || !issueId) return null
  return snapshot.parent.id === issueId ? snapshot.parent : snapshot.children.find((issue) => issue.id === issueId) ?? null
}
