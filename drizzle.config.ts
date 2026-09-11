/**
 * Drizzle Kit config for Anvil's SQLite database.
 *
 * `npm run db:generate` diffs `src/server/db/schema.ts` against the snapshot in
 * `src/server/db/migrations/meta` and writes the next numbered migration. The
 * generated files are applied at app start and must not be edited by hand or
 * renamed — the journal records what has already been applied.
 */
import { createRequire } from 'node:module'
import type { Config } from 'drizzle-kit'

const require = createRequire(import.meta.url)
const workspaceDatabase = require('./scripts/workspace-database.cjs') as () => string

export default {
  schema: './src/server/db/schema.ts',
  out: './src/server/db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: workspaceDatabase()
  }
} satisfies Config
