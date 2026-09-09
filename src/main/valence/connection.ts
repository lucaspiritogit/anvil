import Database from 'better-sqlite3'
import { realpathSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { IssueTracker } from './tracker'

/** Existing storage only. No Store recovery, migration, import, or image cleanup. */
export function openCliTracker(projectPath: string, databasePath = process.env.ANVIL_DATABASE_PATH): IssueTracker {
  if (!databasePath || !isAbsolute(databasePath)) {
    throw new Error('Use the vl launcher supplied by Anvil, or set ANVIL_DATABASE_PATH to its existing absolute database path')
  }
  const connection = new Database(databasePath, { fileMustExist: true })
  try {
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
    connection.close()
    throw error
  }
}
