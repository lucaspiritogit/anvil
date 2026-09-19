/**
 * Drizzle Kit config for Anvil's SQLite database.
 *
 * `npm run db:generate` diffs `apps/server/src/db/schema.ts` against the latest
 * snapshot and writes the next timestamped migration directory. The generated
 * files are applied at app start and must not be edited by hand or renamed.
 */
import { createRequire } from 'node:module'
import type { Config } from 'drizzle-kit'

const require = createRequire(import.meta.url)
const { workspaceDatabase } = require('../../packages/app-data/src/index.ts') as { workspaceDatabase(): string }

export default {
  schema: './apps/server/src/db/schema.ts',
  out: './apps/server/src/db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: workspaceDatabase()
  }
} satisfies Config
