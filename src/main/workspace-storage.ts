import Database from 'better-sqlite3'
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './db/schema'

export interface WorkspaceConnection {
  sqlite: Database.Database
  db: BetterSQLite3Database<typeof schema>
}

/** The app database is a workspace registry. Each workspace owns its data connection. */
export class WorkspaceStorage {
  private readonly connections = new Map<string, WorkspaceConnection>()

  constructor(
    private readonly registry: Database.Database,
    private readonly directory: string,
    private readonly migrationsFolder: string,
    private readonly workspaceDirectory: (id: string) => string
  ) {}

  initialize(): void {
    const migrated = this.registry.prepare("SELECT value FROM app_state WHERE key = 'workspaceStorageVersion'").get()
    const workspaces = this.registry.prepare<[], { id: string }>('SELECT id FROM workspaces').all()
    if (!migrated) {
      // Keep a consistent, standalone copy of the pre-split database for recovery.
      const backup = join(this.directory, 'anvil.before-workspace-storage.db')
      if (!existsSync(backup)) this.registry.prepare('VACUUM INTO ?').run(backup)
      for (const workspace of workspaces) this.importWorkspace(workspace.id)
      this.registry.transaction(() => {
        this.registry.prepare('DELETE FROM projects').run()
        this.registry.prepare('DELETE FROM workspace_settings').run()
        this.registry.prepare('DELETE FROM workspace_preferences').run()
        this.registry.prepare('DELETE FROM settings').run()
        this.registry.prepare("INSERT INTO app_state (key, value) VALUES ('workspaceStorageVersion', '1')").run()
      })()
    }
    for (const workspace of workspaces) this.open(workspace.id)
  }

  private importWorkspace(id: string): void {
    const directory = this.workspaceDirectory(id)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const target = join(directory, 'anvil.db')
    // Publication is last. A completed workspace is never overwritten on retry.
    if (existsSync(target)) return
    const temporary = join(directory, 'anvil.migrating.db')
    rmSync(temporary, { force: true })
    this.registry.prepare('VACUUM INTO ?').run(temporary)
    const database = new Database(temporary)
    try {
      database.pragma('foreign_keys = ON')
      database.transaction(() => {
        database.prepare('DELETE FROM tasks WHERE workspace_id <> ?').run(id)
        database.prepare('DELETE FROM workspace_settings WHERE workspace_id <> ?').run(id)
        database.prepare('DELETE FROM workspace_preferences WHERE workspace_id <> ?').run(id)
        database.prepare('DELETE FROM workspaces WHERE id <> ?').run(id)
        if (id !== 'default') {
          database.prepare(`DELETE FROM projects WHERE id NOT IN (SELECT project_id FROM tasks)
            AND id NOT IN (SELECT last_project_id FROM workspace_preferences WHERE last_project_id IS NOT NULL)`).run()
        }
        database.prepare('DELETE FROM settings').run()
        database.prepare("DELETE FROM app_state WHERE key <> 'legacyComposerImported'").run()
      })()
      if ((database.pragma('foreign_key_check') as unknown[]).length) throw new Error('Workspace migration failed its foreign key check')
      const copy = (source: string, destination: string): void => {
        if (existsSync(source)) cpSync(source, destination, { recursive: true, force: false, errorOnExist: false })
      }
      copy(join(this.directory, 'wallpaper'), join(directory, 'wallpaper'))
      if (id === 'default') {
        copy(join(this.directory, 'github-token.enc'), join(directory, 'github-token.enc'))
        copy(join(this.directory, 'memory'), join(directory, 'memory'))
      }
      const tasks = database.prepare<[], { id: string }>('SELECT id FROM tasks').all()
      for (const task of tasks) {
        if (!/^[A-Za-z0-9_-]+$/.test(task.id)) throw new Error('Invalid migrated task image owner')
        copy(join(this.directory, 'anvil.db.images', task.id), join(directory, 'anvil.db.images', task.id))
      }
    } finally {
      database.close()
    }
    renameSync(temporary, target)
  }

  open(id: string): WorkspaceConnection {
    const cached = this.connections.get(id)
    if (cached) return cached
    const directory = this.workspaceDirectory(id)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    mkdirSync(join(directory, 'wallpaper'), { recursive: true, mode: 0o700 })
    const sqlite = new Database(join(directory, 'anvil.db'))
    try {
      sqlite.pragma('journal_mode = WAL')
      sqlite.pragma('synchronous = NORMAL')
      const db = drizzle(sqlite, { schema })
      sqlite.pragma('foreign_keys = OFF')
      try { migrate(db, { migrationsFolder: this.migrationsFolder }) }
      finally { sqlite.pragma('foreign_keys = ON') }
      const workspace = this.registry.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as { id: string; name: string; name_key: string; created_at: number }
      sqlite.prepare('INSERT INTO workspaces (id, name, name_key, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, name_key = excluded.name_key')
        .run(workspace.id, workspace.name, workspace.name_key, workspace.created_at)
      const connection = { sqlite, db }
      this.connections.set(id, connection)
      return connection
    } catch (error) {
      sqlite.close()
      throw error
    }
  }

  close(): void {
    for (const connection of this.connections.values()) connection.sqlite.close()
    this.connections.clear()
  }

  closeWorkspace(id: string): void {
    this.connections.get(id)?.sqlite.close()
    this.connections.delete(id)
  }
}
