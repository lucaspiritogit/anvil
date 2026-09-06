import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Store } from '../src/main/store'
import { initializeTracker } from 'valence'
import { registerIpc } from '../src/main/ipc'
import type { Task } from '../src/shared/types'
import { handlers, testHome } from './issue-tracker-doubles'

async function main(): Promise<void> {
  const options = { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') }
  const database = join(testHome, '.anvil-composer/anvil.db')
  const store = new Store(database, options)
  registerIpc(() => null)
  initializeTracker(testHome).close()
  store.addProject({
    id: 'project', name: 'Test', path: testHome, createdAt: 0,
    monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github'
  })
  const call = (name: string, input?: unknown): any => handlers.get(name)!(null, input)
  const realNow = Date.now
  let now = 1_800_000_000_000
  Date.now = () => now
  const addTask = (id: string, patch: Partial<Task> = {}): Task => {
    const task: Task = {
      id, projectId: 'project', title: id, prompt: id, agentId: 'codex', agentLabel: 'Codex',
      cwd: testHome, status: 'succeeded', deliveryStatus: 'reviewable',
      startedAt: now - 24 * 60 * 60 * 1000, endedAt: now - 12 * 60 * 60 * 1000,
      inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: 0,
      filesChanged: 1, additions: 1, deletions: 0, ...patch
    }
    store.addTask(task)
    store.appendEvent({ id: `${id}-output`, taskId: id, ts: now, stream: 'stdout', kind: 'output', category: 'message', text: 'Task completed' })
    store.saveTaskExecution({ taskId: id, projectPath: testHome, phase: 'complete', issueIds: [], currentIssueId: null, eventOffset: 0, error: null })
    return task
  }
  try {
    addTask('reviewed')
    const approved: Task = call('tasks:approve', 'reviewed')
    assert.equal(approved.reviewedAt, now)
    now += 4 * 60 * 60 * 1000 - 1
    call('tasks:list')
    assert.equal(store.getTask('reviewed')?.settledAt, undefined, 'Approval starts a fresh four-hour TTL, not task creation')
    now += 1
    call('tasks:list')
    assert.equal(store.getTask('reviewed')?.settledAt, now, 'Settles at the four-hour boundary')
    assert.ok(store.getTaskExecution('reviewed'), 'Settling retains execution metadata')
    assert.ok(store.readEvents('reviewed').length, 'Settling retains output')

    addTask('manual', { deliveryStatus: 'approved', reviewedAt: now })
    const manual: Task = call('tasks:settle', 'manual')
    assert.equal(manual.settledAt, now, 'Manual settling does not wait for the TTL')
    now += 1
    assert.equal(call('tasks:settle', 'manual').settledAt, manual.settledAt, 'Settling is idempotent')

    for (const [id, patch] of [
      ['unreviewed', {}],
      ['running', { status: 'running', deliveryStatus: 'working' }],
      ['failed', { status: 'failed', deliveryStatus: 'agent_failed' }],
      ['cancelled', { status: 'cancelled', deliveryStatus: 'agent_failed' }]
    ] as [string, Partial<Task>][]) {
      addTask(id, patch)
      assert.throws(() => call('tasks:settle', id), /successful, reviewed/)
    }
    addTask('no-changes', { deliveryStatus: 'no_changes' })
    addTask('legacy-approved', { deliveryStatus: 'approved' })
    call('tasks:list')
    assert.ok(store.getTask('no-changes')?.settledAt, 'No-change successes need no code review')
    assert.ok(store.getTask('legacy-approved')?.settledAt, 'Older approvals fall back to completion time')
    for (const id of ['unreviewed', 'running', 'failed', 'cancelled']) {
      assert.equal(store.getTask(id)?.settledAt, undefined, `${id} must remain visible regardless of age`)
    }

    const restarted = new Store(database, options)
    assert.equal(restarted.getTask('manual')?.settledAt, manual.settledAt)
    assert.equal(restarted.getTask('reviewed')?.reviewedAt, approved.reviewedAt)
    restarted.close()
    store.updateTask('manual', { status: 'running' })
    assert.equal(store.getTask('manual')?.settledAt, undefined, 'Resuming a task returns it to active work')
    assert.equal(store.getTask('manual')?.reviewedAt, undefined)
    console.log('Task settlement tests passed: four-hour TTL, approval timestamp, eligibility, manual settling, and persistence.')
  } finally {
    Date.now = realNow
    store.close()
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
