/**
 * Drizzle Kit config for Anvil's SQLite database.
 *
 * `npm run db:generate` diffs `src/server/db/schema.ts` against the latest
 * snapshot and writes the next timestamped migration directory. The generated
 * files are applied at app start and must not be edited by hand or renamed.
 */
import { createRequire } from 'node:module'
import type { Config } from 'drizzle-kit'

const require = createRequire(import.meta.url)
const { workspaceDatabase } = require('./src/shared/app-data.ts') as { workspaceDatabase(): string }

export default {
  schema: './src/server/db/schema.ts',
  out: './src/server/db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: workspaceDatabase()
  }
} satisfies Config
