import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import * as schema from './db/schema'
import type { Workspace } from '../shared/types'

export interface WorkspaceConnection {
  sqlite: Database.Database
  db: BetterSQLite3Database<typeof schema>
}

/** Each workspace owns its SQLite data connection. */
export class WorkspaceStorage {
  private readonly connections = new Map<string, WorkspaceConnection>()

  constructor(
    private readonly migrationsFolder: string,
    private readonly workspaceDirectory: (id: string) => string,
    private readonly getWorkspace: (id: string) => Workspace
  ) {}

  open(id: string): WorkspaceConnection {
    const cached = this.connections.get(id)
    if (cached) return cached
    const directory = this.workspaceDirectory(id)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    mkdirSync(join(directory, 'wallpaper'), { recursive: true, mode: 0o700 })
    const sqlite = new Database(join(directory, 'anvil.db'), {
      nativeBinding: process.env.ANVIL_SQLITE_BINDING
    })
    try {
      sqlite.pragma('journal_mode = WAL')
      sqlite.pragma('synchronous = NORMAL')
      const db = drizzle(sqlite, { schema })
      sqlite.pragma('foreign_keys = OFF')
      try { migrate(db, { migrationsFolder: this.migrationsFolder }) }
      finally { sqlite.pragma('foreign_keys = ON') }
      const workspace = this.getWorkspace(id)
      sqlite.prepare('INSERT INTO workspaces (id, name, name_key, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, name_key = excluded.name_key')
        .run(workspace.id, workspace.name, workspace.name.toLowerCase(), workspace.createdAt)
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
