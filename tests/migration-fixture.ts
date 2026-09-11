import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const migrationsFolder = join(process.cwd(), 'src/server/db/migrations')

/** Build a real historical database without running today's Store against an old schema. */
export function migrateBefore(databaseFile: string, migrationIndex: number): void {
  const previous = join(dirname(databaseFile), `migrations-before-${migrationIndex}`)
  mkdirSync(join(previous, 'meta'), { recursive: true })
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'))
  journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx < migrationIndex)
  writeFileSync(join(previous, 'meta/_journal.json'), JSON.stringify(journal))
  for (const entry of journal.entries) {
    copyFileSync(join(migrationsFolder, `${entry.tag}.sql`), join(previous, `${entry.tag}.sql`))
  }
  const database = new Database(databaseFile)
  try {
    database.pragma('foreign_keys = OFF')
    migrate(drizzle(database), { migrationsFolder: previous })
  } finally {
    database.close()
  }
}
