import type { Config } from 'drizzle-kit'

export default {
  schema: './src/main/memory/schema.ts',
  out: './src/main/memory/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.ANVIL_MEMORY_DATABASE_URL ??
      'postgresql://anvil:anvil@localhost:5432/anvil_memory'
  }
} satisfies Config
