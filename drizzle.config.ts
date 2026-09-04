/**
 * Drizzle Kit config for Anvil's SQLite database.
 *
 * `npm run db:generate` diffs `src/main/db/schema.ts` against the snapshot in
 * `src/main/db/migrations/meta` and writes the next numbered migration. The
 * generated files are applied at app start and must not be edited by hand or
 * renamed — the journal records what has already been applied.
 */
import type { Config } from 'drizzle-kit'

export default {
  schema: './src/main/db/schema.ts',
  out: './src/main/db/migrations',
  dialect: 'sqlite'
} satisfies Config
