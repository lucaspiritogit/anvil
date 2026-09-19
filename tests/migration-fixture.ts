import { DatabaseSync } from 'node:sqlite'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { migrate } from 'drizzle-orm/node-sqlite/migrator'
import { cpSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const migrationsFolder = join(process.cwd(), 'apps/server/src/db/migrations')

/** Build a real historical database without running today's Store against an old schema. */
export function migrateBefore(databaseFile: string, migrationIndex: number): void {
  const previous = join(dirname(databaseFile), `migrations-before-${migrationIndex}`)
  mkdirSync(previous, { recursive: true })
  const migrations = readdirSync(migrationsFolder, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .slice(0, migrationIndex)
  for (const migration of migrations) {
    cpSync(join(migrationsFolder, migration), join(previous, migration), { recursive: true })
  }
  const database = new DatabaseSync(databaseFile)
  try {
    database.exec('PRAGMA foreign_keys = OFF')
    migrate(drizzle({ client: database }), { migrationsFolder: previous })
  } finally {
    database.close()
  }
}
