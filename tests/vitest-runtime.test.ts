import { describe, expect, test } from 'vitest'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { internalTrackerFixture } from './fixtures/internal-valence'
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import { Store } from '../src/server/store'
import { AgentProcessManager } from '../src/server/agents/process-manager'
import { listModels } from '../src/server/agents/models'
import { GitDeliveryManager } from '../src/server/git'
import { AgentProcessManager as DoubleAgent, GitDeliveryManager as DoubleGit, listModels as doubleModels, testHome } from './issue-tracker-doubles'
import { onTestCleanup, cleanupTestResources } from './test-cleanup'
import { registerTestIpc } from './test-ipc'

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
    expect(store.getSettings().fontSize).toBeGreaterThan(0)
    const project = join(testHome, 'project')
    mkdirSync(project)
    const { open } = internalTrackerFixture(project)
    const tracker = open()
    onTestCleanup(() => tracker.close())
    const parent = tracker.createParent({ anvilTaskId: 'task', title: 'Host SQLite probe' })
    expect(tracker.getParent(parent.id).title).toBe('Host SQLite probe')
  })

  test('loads ACP ESM and preserves directly tested process, model and Git modules', () => {
    expect(ClientSideConnection).toBeTypeOf('function')
    expect(ndJsonStream).toBeTypeOf('function')
    expect(AgentProcessManager).not.toBe(DoubleAgent)
    expect(listModels).not.toBe(doubleModels)
    expect(GitDeliveryManager).not.toBe(DoubleGit)
  })

  test('uses orchestration doubles and registers IPC teardown', () => {
    const runtime = registerTestIpc()
    expect(runtime.agentProcesses).toBeInstanceOf(DoubleAgent)
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
