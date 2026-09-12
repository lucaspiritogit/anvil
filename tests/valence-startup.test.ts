import { rendererEvent } from './renderer-fixture'
import { expect, test } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/server/store'
import { registerTestIpc } from './test-ipc'
import { onTestCleanup } from './test-cleanup'
import { handlers, testHome, AgentProcessManager } from './issue-tracker-doubles'

async function tick(): Promise<void> {
  for (let index = 0; index < 8; index++) await new Promise((resolve) => setImmediate(resolve))
}

function fixture() {
  const store = new Store(join(testHome, '.anvil-composer/config.json'), {
    migrationsFolder: join(process.cwd(), 'src/server/db/migrations')
  })
  onTestCleanup(() => store.close())
  const { agentProcesses } = registerTestIpc()
  const agents = agentProcesses as unknown as AgentProcessManager
  const projectId = randomUUID()
  const projectPath = join(testHome, projectId)
  mkdirSync(projectPath)
  onTestCleanup(() => rmSync(projectPath, { recursive: true, force: true }))
  store.addProject({ id: projectId, name: 'Project', path: projectPath, createdAt: 0,
    monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
  const start = async () => {
    const task = await handlers.get('tasks:start')!(rendererEvent, { projectId, agentId: 'codex', prompt: 'Check startup' })
    await tick()
    return task
  }
  return { store, agents, projectId, projectPath, start }
}

test('initializes task-owned parents in Anvil before planning without standalone storage', async () => {
  const { store, projectId, projectPath, start } = fixture()
  const first = await start()
  const state = store.getTaskExecution(first.id)!
  expect(state.parentIssueId).toBeTruthy()
  const tracker = store.issueTracker(projectId)
  onTestCleanup(() => tracker.close())
  expect(tracker.getParent(state.parentIssueId)).toStrictEqual({
    id: state.parentIssueId, anvilTaskId: first.id, title: first.title, description: first.prompt
  })
  const second = await start()
  expect(store.getTaskExecution(second.id)!.parentIssueId).not.toBe(state.parentIssueId)
  expect(tracker.listParents()).toHaveLength(2)
  expect(existsSync(join(projectPath, '.valence'))).toBe(false)
  expect(existsSync(join(homedir(), '.config/valence', projectId))).toBe(false)
})

test('starts and completes tasks while preserving unrelated standalone files', async () => {
  const { store, agents, projectId, projectPath, start } = fixture()
  const directories = [join(projectPath, '.valence'), join(homedir(), '.config/valence', projectId)]
  const originals = new Map<string, Buffer>()
  for (const standaloneDirectory of directories) {
    mkdirSync(standaloneDirectory, { recursive: true })
    onTestCleanup(() => rmSync(standaloneDirectory, { recursive: true, force: true }))
    const standalonePath = join(standaloneDirectory, 'sqlite.db')
    if (standaloneDirectory === directories[0]) {
      const standalone = new Database(standalonePath)
      try {
        // A foreign database must not be inspected, imported, or changed.
        standalone.exec('CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES (\'Preserve me\')')
      } finally {
        standalone.close()
      }
    } else {
      writeFileSync(standalonePath, 'invalid SQLite')
    }
    // Even invalid ownership metadata must not affect Anvil's embedded tracker.
    const metadataPath = join(standaloneDirectory, 'project.json')
    writeFileSync(metadataPath, 'invalid JSON')
    originals.set(standalonePath, readFileSync(standalonePath))
    originals.set(metadataPath, readFileSync(metadataPath))
  }
  const task = await start()
  expect(store.getTaskExecution(task.id)?.phase).toBe('planning')
  agents.plan(task.id, [{ key: 'work', title: 'Work', description: 'Use Anvil storage',
    checklist: ['Verify'], validation: 'Run test' }])
  await tick()
  const state = store.getTaskExecution(task.id)!
  expect(state.currentIssueId).toBeTruthy()
  agents.completeIssue(task.id, state.currentIssueId!, { checklist: [true], evidence: 'Validated in Anvil' })
  await tick()
  expect(store.getTaskExecution(task.id)?.phase).toBe('complete')
  expect(store.getTask(task.id)?.status).toBe('succeeded')
  for (const [path, original] of originals) expect(readFileSync(path)).toEqual(original)
})
