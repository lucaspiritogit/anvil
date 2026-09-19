import { statSync, unwatchFile, watchFile, type BigIntStats } from 'node:fs'
import { join } from 'node:path'
import type { Store } from '../store'

const AUTH_FILES = [
  ['codex', 'auth.json'],
  ['codex', 'config.toml'],
  ['data', 'opencode', 'auth.json'],
  ['config', 'opencode', 'opencode.json'],
  ['config', 'opencode', 'opencode.jsonc']
]

function revision(stats: BigIntStats | undefined): string {
  if (!stats || stats.nlink === 0n) return 'missing'
  return `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`
}

/** Observe atomic credential replacements as well as edits, including newly created profiles. */
export function watchWorkspaceAuthChanges(
  store: Store,
  changed: (workspaceId: string) => void
): () => void {
  const subscriptions = new Map<string, { workspaceId: string, close: () => void }>()
  let closed = false
  const reconcile = (): void => {
    const paths = new Map<string, string>()
    for (const workspace of store.getWorkspaces()) {
      const directory = store.getWorkspaceDirectory(workspace.id)
      for (const file of AUTH_FILES) paths.set(join(directory, ...file), workspace.id)
    }
    for (const [path, subscription] of subscriptions) {
      if (paths.get(path) === subscription.workspaceId) continue
      subscription.close()
      subscriptions.delete(path)
    }
    for (const [path, workspaceId] of paths) {
      if (subscriptions.has(path)) continue
      let previous = revision(statSync(path, { bigint: true, throwIfNoEntry: false }))
      const listener = (stats: BigIntStats): void => {
        if (closed || subscriptions.get(path)?.workspaceId !== workspaceId) return
        const next = revision(stats)
        if (next === previous) return
        previous = next
        const workspace = store.getWorkspaces().find((workspace) => workspace.id === workspaceId)
        if (workspace && AUTH_FILES.some((file) => join(store.getWorkspaceDirectory(workspaceId), ...file) === path)) {
          changed(workspaceId)
        }
      }
      // Poll only known files. Recursive fs.watch also watches every worktree's
      // dependencies and can exhaust Linux inotify limits before filtering events.
      watchFile(path, { bigint: true, persistent: false, interval: 1_000 }, listener)
      subscriptions.set(path, { workspaceId, close: () => unwatchFile(path, listener) })
    }
  }
  reconcile()
  const timer = setInterval(reconcile, 1_000)
  timer.unref()
  return () => {
    closed = true
    clearInterval(timer)
    for (const subscription of subscriptions.values()) subscription.close()
    subscriptions.clear()
  }
}
