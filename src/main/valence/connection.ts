import Database from 'better-sqlite3'
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { validateWorkspaceFolderName } from '../workspace-directories'
import { readRootConfig } from '../root-config'
import { IssueTracker } from './tracker'

/** Existing storage only. No Store recovery, migration, import, or image cleanup. */
export function openCliTracker(projectPath: string, databasePath = process.env.ANVIL_DATABASE_PATH): IssueTracker {
  if (!databasePath || !isAbsolute(databasePath)) {
    throw new Error('Use the vl launcher supplied by Anvil, or set ANVIL_DATABASE_PATH to its existing absolute database path')
  }
  if (databasePath.endsWith('.json')) {
    const config = readRootConfig(databasePath)
    const workspace = config.workspaces.find((entry) => entry.id === config.activeWorkspaceId)!
    return openCliTracker(projectPath, join(dirname(databasePath), 'workspaces', workspace.name, 'anvil.db'))
  }
  const connection = new Database(databasePath, { fileMustExist: true })
  try {
    const registry = connection.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'app_state'").get()
    if (registry && connection.prepare("SELECT 1 FROM app_state WHERE key = 'workspaceStorageVersion'").get()) {
      const workspace = connection.prepare(`SELECT name FROM workspaces WHERE id =
        COALESCE((SELECT value FROM app_state WHERE key = 'activeWorkspaceId'), 'default')`).get() as { name: string } | undefined
      if (!workspace) throw new Error('Selected workspace not found')
      validateWorkspaceFolderName(workspace.name)
      connection.close()
      return openCliTracker(projectPath, join(dirname(databasePath), 'workspaces', workspace.name, 'anvil.db'))
    }
    const canonical = realpathSync(resolve(projectPath))
    const projects = connection.prepare('SELECT id, path FROM projects').all() as { id: string; path: string }[]
    const matches = projects.filter((project) => {
      try { return realpathSync(project.path) === canonical } catch { return false }
    })
    if (matches.length !== 1) throw new Error('Project must resolve to one registered Anvil project. Use --project with the original project directory')
    for (const table of ['parent_issues', 'issues', 'issue_dependencies']) {
      connection.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()
    }
    return new IssueTracker(connection, matches[0].id, 'owned')
  } catch (error) {
    if (connection.open) connection.close()
    throw error
  }
}
