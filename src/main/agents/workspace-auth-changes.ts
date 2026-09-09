import { mkdirSync, watch } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { Store } from '../store'

/** Observe atomic credential replacements as well as edits, including newly created profiles. */
export function watchWorkspaceAuthChanges(
  store: Store,
  changed: (workspaceId: string) => void
): () => void {
  const root = dirname(store.getWorkspaceDirectory('default'))
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const watcher = watch(root, { recursive: true, persistent: false }, (_event, filename) => {
    if (!filename) return
    const path = filename.toString()
    if (!['auth.json', 'config.toml', 'opencode.json', 'opencode.jsonc'].includes(basename(path))) return
    const workspaceId = path.split(/[\\/]/)[0]
    if (store.getWorkspaces().some((workspace) => workspace.id === workspaceId)) changed(workspaceId)
  })
  watcher.on('error', (error) => console.warn('Could not watch workspace authentication changes:', error.message))
  return () => watcher.close()
}
