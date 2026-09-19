import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'

export { validateWorkspaceFolderName } from '@anvil/app-data'

/** Moving a parent directory also requires repairing Git's linked-worktree pointers. */
export function moveWorkspaceDirectory(source: string, destination: string): void {
  if (source === destination || !existsSync(source)) return
  if (existsSync(destination)) {
    const sourceStat = statSync(source)
    const destinationStat = statSync(destination)
    if (sourceStat.dev !== destinationStat.dev || sourceStat.ino !== destinationStat.ino) {
      throw new Error('The workspace destination folder already exists')
    }
  }
  const repair = (directory: string): void => {
    const worktrees = join(directory, 'worktrees')
    if (!existsSync(worktrees)) return
    for (const entry of readdirSync(worktrees, { withFileTypes: true })) {
      const worktree = join(worktrees, entry.name)
      if (entry.isDirectory() && existsSync(join(worktree, '.git'))) {
        execFileSync('git', ['-C', worktree, 'worktree', 'repair', worktree], { stdio: 'pipe' })
      }
    }
  }
  renameSync(source, destination)
  try {
    repair(destination)
  } catch (error) {
    renameSync(destination, source)
    repair(source)
    throw error
  }
}

export function relocateTaskPaths(sqlite: DatabaseSync, previous: string, directory: string): void {
  if (previous === directory) return
  const prefix = previous + sep
  sqlite.prepare(`UPDATE projects SET path = ? || substr(path, length(?) + 1)
    WHERE path = ? OR substr(path, 1, length(?)) = ?`)
    .run(directory, previous, previous, prefix, prefix)
  sqlite.prepare(`UPDATE tasks SET cwd = ? || substr(cwd, length(?) + 1)
    WHERE cwd = ? OR substr(cwd, 1, length(?)) = ?`)
    .run(directory, previous, previous, prefix, prefix)
}
