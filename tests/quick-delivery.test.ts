import { expect, test, vi } from 'vitest'
import { onTestCleanup } from './test-cleanup'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from '../src/server/store'
import { registerReviewHandlers } from '../src/server/handlers/review'
import { createHandlerRegistry } from '../src/server/handler-registry'
import type { Project, Task } from '../src/shared/types'

function setup() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-quick-delivery-')))
  onTestCleanup(() => rmSync(home, { recursive: true, force: true }))
  const store = new Store(join(home, `${randomUUID()}`, 'config.json'), { migrationsFolder: join(process.cwd(), 'src/server/db/migrations') })
  onTestCleanup(() => store.close())
  const project: Project = {
    id: 'project', name: 'Project', path: home, createdAt: 0,
    monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github'
  }
  store.addProject(project)
  const headCommit = '9'.repeat(40)
  const pushCalls: unknown[][] = []
  const updated: Task[] = []
  const gitDelivery = {
    commitPaths: vi.fn(async () => headCommit),
    getPushPreview: vi.fn(async () => ({
      targetBranch: 'main', targetCommit: headCommit, remote: 'origin',
      remoteTargetCommit: '1'.repeat(40), remoteUrlHash: 'f'.repeat(64)
    })),
    push: vi.fn(async (...args: unknown[]) => { pushCalls.push(args) })
  }
  const registry = createHandlerRegistry()
  registerReviewHandlers(registry, {
    store,
    agentProcesses: { isRunning: () => false } as never,
    gitDelivery: gitDelivery as never,
    send: (channel: string, payload: unknown) => {
      if (channel === 'task:updated') updated.push(payload as Task)
    },
    recordSystemEvent: () => {},
    requireFinishedTask: () => {},
    approveIssue: (() => {}) as never,
    rejectIssue: (() => {}) as never,
    runMergeConflictRepair: (() => {}) as never
  })
  const addQuickTask = (): Task => store.addTask({
    id: randomUUID(), projectId: project.id, agentId: 'codex', agentLabel: 'Codex',
    style: 'quick', reviewPolicy: 'review_each_issue', checkoutMode: 'local',
    prompt: 'Change', title: 'Change thing', cwd: home, status: 'succeeded', startedAt: Date.now(),
    deliveryStatus: 'reviewable', reviewPaths: ['src/quick.ts'],
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null,
    filesChanged: 1, additions: 1, deletions: 0
  })
  return { store, registry, headCommit, pushCalls, updated, addQuickTask }
}

test('commit-quick with push records the pushed head commit on the task', async () => {
  const { store, registry, headCommit, pushCalls, updated, addQuickTask } = setup()
  const task = addQuickTask()

  const committed = await registry.invoke('tasks:commit-quick', { taskId: task.id, push: true, message: 'test: push me' }) as Task

  expect(committed).toMatchObject({ deliveryStatus: 'approved', headCommit, pushedCommit: headCommit })
  expect(pushCalls).toHaveLength(1)
  expect(store.getTask(task.id)).toMatchObject({ headCommit, pushedCommit: headCommit })
  expect(updated.at(-1)).toMatchObject({ id: task.id, pushedCommit: headCommit })
})

test('commit-quick without push leaves the head commit unpushed', async () => {
  const { store, registry, headCommit, pushCalls, addQuickTask } = setup()
  const task = addQuickTask()

  const committed = await registry.invoke('tasks:commit-quick', { taskId: task.id, push: false, message: 'test: local only' }) as Task

  expect(committed).toMatchObject({ deliveryStatus: 'approved', headCommit })
  expect(committed.pushedCommit).toBeUndefined()
  expect(pushCalls).toHaveLength(0)
  expect(store.getTask(task.id)?.pushedCommit).toBeUndefined()
})

test('pushing a committed quick task records the pushed head commit', async () => {
  const { store, registry, headCommit, pushCalls, updated, addQuickTask } = setup()
  const task = addQuickTask()
  await registry.invoke('tasks:commit-quick', { taskId: task.id, push: false, message: 'test: push later' })

  const preview = await registry.invoke('tasks:push-preview', task.id)
  const pushed = await registry.invoke('tasks:push', { taskId: task.id, preview }) as Task

  expect(pushed).toMatchObject({ deliveryStatus: 'approved', headCommit, pushedCommit: headCommit })
  expect(pushCalls).toHaveLength(1)
  expect(store.getTask(task.id)?.pushedCommit).toBe(headCommit)
  expect(updated.at(-1)).toMatchObject({ id: task.id, pushedCommit: headCommit })
})
