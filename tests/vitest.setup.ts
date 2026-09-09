import { afterAll, afterEach, expect, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import type Database from 'better-sqlite3'
import { cleanupTestResources } from './test-cleanup'

const originalEnvironment = { ...process.env }
const home = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-vitest-')))
process.env.HOME = home
process.env.USERPROFILE = home
process.env.XDG_CONFIG_HOME = join(home, '.config')
process.env.APPDATA = join(home, 'AppData', 'Roaming')
process.env.LOCALAPPDATA = join(home, 'AppData', 'Local')
process.env.ANVIL_TEST_HOME = home
process.env.ANVIL_TEST_NODE = process.execPath
delete process.env.ANVIL_DATA_DIR
const suiteEnvironment = { ...process.env }

// Both Vite imports and Valence's external CommonJS require use the same real
// host-native SQLite constructor. Electron subprocesses keep their own addon.
const require = createRequire(import.meta.url)
const sqliteId = require.resolve('better-sqlite3')
require(sqliteId)
const sqliteModule = require.cache[sqliteId]!
const originalSqlite = sqliteModule.exports
const HostDatabase = require(resolve('node_modules/.anvil-vitest-native/better-sqlite3')) as typeof Database
const databases = new Set<Database.Database>()
const TestDatabase = new Proxy(HostDatabase, {
  construct(target, args) {
    const database = Reflect.construct(target, args) as Database.Database
    databases.add(database)
    return database
  },
  apply(target, _thisArg, args) {
    const database = Reflect.construct(target, args) as Database.Database
    databases.add(database)
    return database
  }
})
sqliteModule.exports = TestDatabase
vi.doMock('better-sqlite3', () => ({ default: TestDatabase }))
vi.doMock('electron', () => import('./issue-tracker-doubles'))
const realGitSuites = new Set(['issue-tracker-git', 'git-delivery', 'git-merge', 'github-git', 'vitest-runtime'])
const suite = basename(expect.getState().testPath ?? '', '.test.ts')
if (!realGitSuites.has(suite)) {
  vi.doMock('../src/main/git-delivery', () => import('./issue-tracker-doubles'))
}

async function cleanup(): Promise<void> {
  try {
    await cleanupTestResources()
  } finally {
    for (const database of databases) if (database.open) database.close()
    databases.clear()
    const doubles = await import('./issue-tracker-doubles')
    doubles.resetTestDoubles()
    vi.restoreAllMocks()
    if (vi.isFakeTimers()) vi.clearAllTimers()
    vi.useRealTimers()
    for (const key of Object.keys(process.env)) if (!(key in suiteEnvironment)) delete process.env[key]
    Object.assign(process.env, suiteEnvironment)
  }
}
afterEach(cleanup)
afterAll(async () => {
  try { await cleanup() } finally {
    sqliteModule.exports = originalSqlite
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key]
    Object.assign(process.env, originalEnvironment)
    rmSync(home, { recursive: true, force: true })
  }
})
