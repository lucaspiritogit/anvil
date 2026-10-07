import { expect, test, vi } from 'vitest'
import { onTestCleanup } from './test-cleanup'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from '../apps/server/src/store'
import { registerReviewHandlers } from '../apps/server/src/handlers/review'
import { createHandlerRegistry } from '../apps/server/src/handler-registry'
import type { Project, Task } from '@anvil/protocol/types'

function setup() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-quick-delivery-')))
  onTestCleanup(() => rmSync(home, { recursive: true, force: true }))
  const store = new Store(join(home, `${randomUUID()}`, 'config.json'), { migrationsFolder: join(process.cwd(), 'apps/server/src/db/migrations') })
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
    push: vi.fn(async (...args: unknown[]) => { pushCalls.push(args) }),
    getSyncStatus: vi.fn(async () => ({
      branch: 'main', localCommit: '1'.repeat(40), remoteCommit: '1'.repeat(40), ahead: 0, behind: 0, overlappingPaths: [] as string[]
    })),
    pull: vi.fn(async (_path: string, expected: { branch: string; remoteCommit: string }) => ({
      branch: expected.branch, localCommit: expected.remoteCommit, remoteCommit: expected.remoteCommit, ahead: 0, behind: 0, overlappingPaths: []
    })),
    getWorkingTreeDiff: vi.fn(async (_repoPath: string, _paths: string[]) => ({
      patch: '', commits: [], paths: [] as string[], filesChanged: 0, additions: 0, deletions: 0
    }))
  }
  const registry = createHandlerRegistry()
  registerReviewHandlers(registry, {
    store,
    agentProcesses: { isRunning: () => false } as never,
    gitDelivery: gitDelivery as never,
    send: (channel: string, payload: unknown) => {
      if (channel === 'task:updated') updated.push(payload as Task)
    },
    recordSystemEvent: (taskId: string, text: string) => { events.push({ taskId, text }) },
    requireFinishedTask: () => {},
    approveIssue: (() => {}) as never,
    rejectIssue: (() => {}) as never,
    runMergeConflictRepair: (() => {}) as never
  })
  const events: { taskId: string; text: string }[] = []
  const addQuickTask = (overrides: Partial<Task> = {}): Task => store.addTask({
    id: randomUUID(), projectId: project.id, agentId: 'codex', agentLabel: 'Codex',
    style: 'quick', reviewPolicy: 'review_each_issue', checkoutMode: 'local',
    prompt: 'Change', title: 'Change thing', cwd: home, status: 'succeeded', startedAt: Date.now(),
    deliveryStatus: 'reviewable', reviewPaths: ['src/quick.ts'],
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null,
    filesChanged: 1, additions: 1, deletions: 0,
    ...overrides
  })
  return { store, registry, headCommit, pushCalls, updated, events, gitDelivery, addQuickTask }
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

test('commit-quick approves overlapping local quick tasks whose changes it committed', async () => {
  const { store, registry, headCommit, updated, events, gitDelivery, addQuickTask } = setup()
  const task = addQuickTask({ title: 'Recolor' })
  const sibling = addQuickTask()
  const unrelated = addQuickTask({ reviewPaths: ['src/other.ts'] })

  await registry.invoke('tasks:commit-quick', { taskId: task.id, push: false, message: 'test: shared file' })

  expect(gitDelivery.getWorkingTreeDiff).toHaveBeenCalledTimes(1)
  expect(gitDelivery.getWorkingTreeDiff).toHaveBeenCalledWith(store.getProjects()[0].path, ['src/quick.ts'])
  expect(store.getTask(sibling.id)).toMatchObject({ deliveryStatus: 'approved', headCommit })
  expect(store.getTask(unrelated.id)).toMatchObject({ deliveryStatus: 'reviewable' })
  expect(updated.at(-1)).toMatchObject({ id: sibling.id, deliveryStatus: 'approved' })
  expect(events).toContainEqual({ taskId: sibling.id, text: `Changes were committed with "Recolor" as ${headCommit.slice(0, 8)}.` })
})

test('commit-quick refreshes overlapping local quick tasks that still have changes', async () => {
  const { store, registry, gitDelivery, addQuickTask } = setup()
  const task = addQuickTask()
  const sibling = addQuickTask({ reviewPaths: ['src/quick.ts', 'src/rest.ts'], filesChanged: 2, additions: 4, deletions: 1 })
  gitDelivery.getWorkingTreeDiff.mockResolvedValueOnce({
    patch: 'diff --git a/src/rest.ts b/src/rest.ts', commits: [], paths: ['src/rest.ts'], filesChanged: 1, additions: 2, deletions: 0
  })

  await registry.invoke('tasks:commit-quick', { taskId: task.id, push: false, message: 'test: partial overlap' })

  expect(store.getTask(sibling.id)).toMatchObject({
    deliveryStatus: 'reviewable', reviewPaths: ['src/rest.ts'], filesChanged: 1, additions: 2, deletions: 0
  })
  expect(store.getTask(sibling.id)?.headCommit).toBeUndefined()
})

test('commit-quick with push refuses to commit when origin has new commits', async () => {
  const { store, registry, gitDelivery, addQuickTask } = setup()
  const task = addQuickTask()
  gitDelivery.getSyncStatus.mockResolvedValueOnce({
    branch: 'main', localCommit: '1'.repeat(40), remoteCommit: '2'.repeat(40), ahead: 0, behind: 2, overlappingPaths: []
  })

  await expect(registry.invoke('tasks:commit-quick', { taskId: task.id, push: true, message: 'test: behind' }))
    .rejects.toThrow('origin/main has 2 new commits. Pull before committing and pushing.')

  expect(gitDelivery.commitPaths).not.toHaveBeenCalled()
  expect(store.getTask(task.id)).toMatchObject({ deliveryStatus: 'reviewable' })
})

test('pull fast-forwards the checkout and refreshes local quick task diffs', async () => {
  const { store, registry, events, gitDelivery, addQuickTask } = setup()
  const task = addQuickTask()
  const sibling = addQuickTask({ reviewPaths: ['src/rest.ts'] })
  gitDelivery.getWorkingTreeDiff.mockImplementation(async (_repoPath: string, paths: string[]) => ({
    patch: 'diff', commits: [], paths, filesChanged: 1, additions: 7, deletions: 3
  }))
  const target = { branch: 'main', localCommit: '1'.repeat(40), remoteCommit: '2'.repeat(40) }

  const status = await registry.invoke('tasks:pull', { taskId: task.id, ...target })

  expect(status).toMatchObject({ localCommit: target.remoteCommit, behind: 0 })
  expect(gitDelivery.pull).toHaveBeenCalledWith(store.getProjects()[0].path, target, expect.any(Function))
  expect(store.getTask(task.id)).toMatchObject({ deliveryStatus: 'reviewable', additions: 7, deletions: 3 })
  expect(store.getTask(sibling.id)).toMatchObject({ deliveryStatus: 'reviewable', additions: 7, deletions: 3 })
  expect(events).toContainEqual({ taskId: task.id, text: 'Pulled main from origin, fast-forwarding 11111111 to 22222222.' })
})
