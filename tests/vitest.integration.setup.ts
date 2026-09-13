import { createRequire } from 'node:module'

export default function prepareIntegrationTests(): void {
  const require = createRequire(import.meta.url)
  const { prepareNodeSqlite } = require('../scripts/prepare-node-native.cjs') as { prepareNodeSqlite(): string }
  process.env.ANVIL_TEST_SQLITE_BINDING = prepareNodeSqlite()
}
