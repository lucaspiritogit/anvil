import { afterAll, afterEach, expect, vi } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
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

const databases = new Set<DatabaseSync>()
class TestDatabase extends DatabaseSync {
  constructor(...args: ConstructorParameters<typeof DatabaseSync>) {
    super(...args)
    databases.add(this)
  }
}
vi.doMock('node:sqlite', async () => ({
  ...await vi.importActual<typeof import('node:sqlite')>('node:sqlite'),
  DatabaseSync: TestDatabase
}))
vi.doMock('electron', () => import('./issue-tracker-doubles'))
const realGitSuites = new Set(['task-branch', 'task-recovery', 'issue-tools', 'task-stacks', 'issue-tracker-git', 'git-delivery', 'git-merge', 'github-git', 'vitest-runtime'])
const suite = basename(expect.getState().testPath ?? '', '.test.ts')
if (!realGitSuites.has(suite)) {
  vi.doMock('../src/server/git', () => import('./issue-tracker-doubles'))
}

async function cleanup(): Promise<void> {
  try {
    await cleanupTestResources()
  } finally {
    for (const database of databases) if (database.isOpen) database.close()
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
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key]
    Object.assign(process.env, originalEnvironment)
    rmSync(home, { recursive: true, force: true })
  }
})
