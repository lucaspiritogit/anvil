import { rendererEvent } from './renderer-fixture'
import { expect, test, vi } from 'vitest'
import { join } from 'node:path'
import { Store } from '../src/main/store'
import { TaskIssues } from '../src/main/tasks/task-issues'
import { registerTestIpc } from './test-ipc'
import type { Task } from '../src/shared/types'
import { handlers, testHome } from './issue-tracker-doubles'

test('settles eligible tasks at the review TTL and persists manual settlement', async () => {
  const options = { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') }
  const database = join(testHome, '.anvil-composer/anvil.db')
  const store = new Store(database, options)
  registerTestIpc()
  store.addProject({
    id: 'project', name: 'Test', path: testHome, createdAt: 0,
    monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github'
  })
  const call = (name: string, input?: unknown): any => handlers.get(name)!(rendererEvent, input)
  let now = 1_800_000_000_000
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const addTask = (id: string, patch: Partial<Task> = {}): Task => {
    const task: Task = {
      id, projectId: 'project', title: id, prompt: id, agentId: 'codex', agentLabel: 'Codex',
      cwd: testHome, status: 'succeeded', deliveryStatus: 'reviewable', branchName: 'task',
      startedAt: now - 24 * 60 * 60 * 1000, endedAt: now - 3 * 24 * 60 * 60 * 1000,
      inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: 0,
      filesChanged: 1, additions: 1, deletions: 0, ...patch
    }
    store.addTask(task)
    store.appendEvent({ id: `${id}-output`, taskId: id, ts: now, stream: 'stdout', kind: 'output', category: 'message', text: 'Task completed' })
    store.saveTaskExecution({ ...new TaskIssues(store).initialize(id, testHome), phase: 'complete' })
    return task
  }
  try {
    addTask('reviewed')
    const approved: Task = await call('tasks:approve', { taskId: 'reviewed', preview: await call('tasks:merge-preview', 'reviewed') })
    expect(approved.reviewedAt).toBe(now)
    now += 2 * 24 * 60 * 60 * 1000 - 1
    call('tasks:list')
    expect(store.getTask('reviewed')?.settledAt, 'Approval starts a fresh two-day TTL, not task creation').toBe(undefined)
    now += 1
    call('tasks:list')
    expect(store.getTask('reviewed')?.settledAt, 'Settles at the two-day boundary').toBe(now)
    expect(store.getTaskExecution('reviewed'), 'Settling retains execution metadata').toBeTruthy()
    expect(store.readEvents('reviewed').length, 'Settling retains output').toBeTruthy()

    addTask('manual', { deliveryStatus: 'approved', reviewedAt: now })
    const manual: Task = call('tasks:settle', 'manual')
    expect(manual.settledAt, 'Manual settling does not wait for the TTL').toBe(now)
    now += 1
    expect(call('tasks:settle', 'manual').settledAt, 'Settling is idempotent').toBe(manual.settledAt)

    for (const [id, patch] of [
      ['unreviewed', {}],
      ['running', { status: 'running', deliveryStatus: 'working' }],
      ['failed', { status: 'failed', deliveryStatus: 'agent_failed' }],
      ['cancelled', { status: 'cancelled', deliveryStatus: 'agent_failed' }]
    ] as [string, Partial<Task>][]) {
      addTask(id, patch)
      expect(() => call('tasks:settle', id)).toThrow(id === 'running' ? /not finished executing/ : /successful, reviewed/)
    }
    addTask('no-changes', { deliveryStatus: 'no_changes' })
    addTask('legacy-approved', { deliveryStatus: 'approved' })
    call('tasks:list')
    expect(store.getTask('no-changes')?.settledAt, 'No-change successes need no code review').toBeTruthy()
    expect(store.getTask('legacy-approved')?.settledAt, 'Older approvals fall back to completion time').toBeTruthy()
    for (const id of ['unreviewed', 'running', 'failed', 'cancelled']) {
      expect(store.getTask(id)?.settledAt, `${id} must remain visible regardless of age`).toBe(undefined)
    }

    const restarted = new Store(database, options)
    expect(restarted.getTask('manual')?.settledAt).toBe(manual.settledAt)
    expect(restarted.getTask('reviewed')?.reviewedAt).toBe(approved.reviewedAt)
    restarted.close()
    store.updateTask('manual', { status: 'running' })
    expect(store.getTask('manual')?.settledAt, 'Resuming a task returns it to active work').toBe(undefined)
    expect(store.getTask('manual')?.reviewedAt).toBe(undefined)
  } finally {
    store.close()
  }
})
