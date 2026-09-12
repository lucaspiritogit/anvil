import { describe, expect, test } from 'vitest'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { internalTrackerFixture } from './fixtures/internal-valence'
import { Store } from '../src/server/store'
import { testHome } from './issue-tracker-doubles'
import { onTestCleanup, cleanupTestResources } from './test-cleanup'

describe('Vitest runtime', () => {
  test('isolates application storage and opens real native databases', () => {
    expect(homedir()).toBe(testHome)
    expect(process.env.USERPROFILE).toBe(testHome)
    expect(process.env.ANVIL_DATA_DIR).toBeUndefined()
    expect(process.env.ANVIL_TEST_NODE).toBe(process.execPath)
    const store = new Store(join(testHome, '.anvil-composer', 'config.json'), {
      migrationsFolder: join(process.cwd(), 'src/server/db/migrations')
    })
    onTestCleanup(() => store.close())
    const project = join(testHome, 'project')
    mkdirSync(project)
    const { open } = internalTrackerFixture(project)
    const tracker = open()
    onTestCleanup(() => tracker.close())
    const parent = tracker.createParent({ anvilTaskId: 'task', title: 'Host SQLite probe' })
    expect(tracker.getParent(parent.id).title).toBe('Host SQLite probe')
  })

  test('drains all cleanup callbacks even when one fails', async () => {
    const calls: number[] = []
    onTestCleanup(() => { calls.push(1) })
    onTestCleanup(() => { calls.push(2); throw new Error('cleanup probe') })
    onTestCleanup(() => { calls.push(3) })
    await expect(cleanupTestResources()).rejects.toThrow('Test resource cleanup failed')
    expect(calls).toEqual([3, 2, 1])
  })

})
