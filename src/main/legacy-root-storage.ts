import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { existsSync, mkdirSync, mkdtempSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_WORKSPACE_ID, type Workspace } from '../shared/types'
import { normalizeWorkspaceName, type RootConfig } from './root-config'
import { moveWorkspaceDirectory } from './workspace-directories'
import { WorkspaceStorage } from './workspace-storage'

/** Only upgrades open the old root database. Normal startup reads config.json. */
export function migrateLegacyRoot(databaseFile: string, migrationsFolder: string): RootConfig {
  const directory = dirname(databaseFile)
  const sqlite = new Database(databaseFile, { fileMustExist: true })
  let storage: WorkspaceStorage | undefined
  try {
    const backups = join(directory, 'backups')
    mkdirSync(backups, { recursive: true, mode: 0o700 })
    const backup = join(backups, 'anvil.before-root-json.db')
    if (!existsSync(backup)) sqlite.prepare('VACUUM INTO ?').run(backup)
    sqlite.pragma('foreign_keys = OFF')
    try {
      migrate(drizzle(sqlite), { migrationsFolder })
    } finally {
      sqlite.pragma('foreign_keys = ON')
    }
    if (!sqlite.prepare('SELECT id FROM workspaces WHERE id = ?').get(DEFAULT_WORKSPACE_ID)) {
      sqlite.transaction(() => {
        sqlite.prepare('INSERT INTO workspaces (id, name, name_key, created_at) VALUES (?, ?, ?, ?)')
          .run(DEFAULT_WORKSPACE_ID, 'Default', 'default', Date.now())
        sqlite.prepare('INSERT OR IGNORE INTO workspace_settings (workspace_id, key, value) SELECT ?, key, value FROM settings')
          .run(DEFAULT_WORKSPACE_ID)
      })()
    }
    const workspaces = sqlite.prepare<[], Workspace>('SELECT id, name, created_at AS createdAt FROM workspaces ORDER BY created_at, id').all()
    const getWorkspace = (id: string): Workspace => {
      const workspace = workspaces.find((entry) => entry.id === id)
      if (!workspace) throw new Error('Workspace not found')
      return workspace
    }
    const workspaceDirectory = (id: string): string => join(directory, 'workspaces', normalizeWorkspaceName(getWorkspace(id).name).name)
    const migrateDirectories = !sqlite.prepare("SELECT value FROM app_state WHERE key = 'workspaceDirectoryVersion'").get()
    if (migrateDirectories) {
      for (const workspace of workspaces) {
        if (!/^(default|[0-9a-f-]{36})$/.test(workspace.id)) throw new Error('Invalid legacy workspace directory ID')
        const previous = join(directory, 'workspaces', workspace.id)
        moveWorkspaceDirectory(previous, workspaceDirectory(workspace.id))
        relocateTaskPaths(sqlite, previous, workspaceDirectory(workspace.id))
      }
    }
    storage = new WorkspaceStorage(directory, migrationsFolder, workspaceDirectory, getWorkspace)
    storage.importLegacy(sqlite)
    for (const workspace of workspaces) {
      const connection = storage.open(workspace.id)
      if (migrateDirectories) relocateTaskPaths(connection.sqlite, join(directory, 'workspaces', workspace.id), workspaceDirectory(workspace.id))
    }
    const selected = sqlite.prepare<[], { value: string }>("SELECT value FROM app_state WHERE key = 'activeWorkspaceId'").get()
    return {
      version: 1,
      workspaces,
      activeWorkspaceId: workspaces.some((workspace) => workspace.id === selected?.value) ? selected!.value : DEFAULT_WORKSPACE_ID
    }
  } finally {
    storage?.close()
    sqlite.close()
  }
}

/** Keep recovery copies out of the root after the JSON config has been published. */
export function archiveLegacyRoot(databaseFile: string): void {
  if (!existsSync(databaseFile)) return
  const backups = join(dirname(databaseFile), 'backups')
  mkdirSync(backups, { recursive: true, mode: 0o700 })
  const archive = mkdtempSync(join(backups, 'root-sqlite-'))
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(databaseFile + suffix)) renameSync(databaseFile + suffix, join(archive, 'anvil.db' + suffix))
  }
  const previousBackup = join(dirname(databaseFile), 'anvil.before-workspace-storage.db')
  if (existsSync(previousBackup)) renameSync(previousBackup, join(archive, 'anvil.before-workspace-storage.db'))
}

export function relocateTaskPaths(sqlite: Database.Database, previous: string, directory: string): void {
  if (previous === directory) return
  sqlite.prepare(`UPDATE tasks SET cwd = ? || substr(cwd, ?) WHERE substr(cwd, 1, ?) = ?`)
    .run(directory, previous.length + 1, previous.length + 1, previous + '/')
}
