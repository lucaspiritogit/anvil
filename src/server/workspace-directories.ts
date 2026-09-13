import type Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

export { validateWorkspaceFolderName } from '../shared/app-data'

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

export function relocateTaskPaths(sqlite: Database.Database, previous: string, directory: string): void {
  if (previous === directory) return
  sqlite.prepare(`UPDATE tasks SET cwd = ? || substr(cwd, ?) WHERE substr(cwd, 1, ?) = ?`)
    .run(directory, previous.length + 1, previous.length + 1, previous + '/')
}
