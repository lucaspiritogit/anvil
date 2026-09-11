import { EventEmitter } from 'node:events'
import type { NotificationConstructorOptions } from 'electron'
import { registerTaskNotifications } from '../src/main/task-notifications'
import { callIssueTool } from '../src/main/issue-tools/server'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { Store } from '../src/main/store'
import { registerTaskExecution } from '../src/main/tasks/task-execution'
import { registerTaskEvents } from '../src/main/tasks/events'
import type { ExitInfo, AgentProcessManager as RealAgentProcessManager } from '../src/main/agents/process-manager'
import type { GitDeliveryManager as RealGitDeliveryManager } from '../src/main/git-delivery'
import { AgentProcessManager, GitDeliveryManager, testHome } from './issue-tracker-doubles'
import { onTestCleanup } from './test-cleanup'

async function tick(): Promise<void> {
  for (let index = 0; index < 5; index++) await new Promise<void>((resolve) => setImmediate(resolve))
}

async function setup() {
  const store = new Store(join(testHome, randomUUID(), 'anvil.db'), {
    migrationsFolder: join(process.cwd(), 'src/main/db/migrations')
  })
  onTestCleanup(() => store.close())
  store.addProject({ id: 'project', name: 'Project', path: testHome, createdAt: 0,
    monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
  const task = store.addTask({
    id: 'task', projectId: 'project', agentId: 'opencode', agentLabel: 'OpenCode', model: 'provider/model',
    prompt: 'Make the requested change', title: 'Task', cwd: testHome, status: 'running', startedAt: Date.now(),
    deliveryStatus: 'working', branchName: 'task-branch', baseBranch: 'main', baseCommit: 'base',
    filesChanged: 0, additions: 0, deletions: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0,
    totalTokens: 0, costUsd: null
  })
  const agents = new AgentProcessManager()
  onTestCleanup(() => { agents.emit('closing'); return agents.close() })
  const git = new GitDeliveryManager()
  const context = { store, agentProcesses: agents as unknown as RealAgentProcessManager,
    gitDelivery: git as unknown as RealGitDeliveryManager, send: () => {} }
  const events = registerTaskEvents(context)
  const finish = vi.fn(async (info: ExitInfo) => {
    store.updateTask(task.id, { status: info.cancelled ? 'cancelled' : info.code === 0 ? 'succeeded' : 'pending' })
  })
  const execution = registerTaskExecution({ ...context, ...events }, finish)
  const state = execution.initializeTask(task.id, testHome, { reasoningEffort: 'high' })
  const tracker = store.issueTracker(task.projectId, task.workspaceId)
  onTestCleanup(() => tracker.close())
  const issue = tracker.create({ parentId: state.parentIssueId, title: 'Implement', description: 'Change source',
    checklist: ['Implemented'], validation: 'Targeted check', priority: 'medium', labels: [] })
  await execution.finishTaskTurn({ taskId: task.id, code: 0, cancelled: false })
  await tick()
  agents.emit('session', { taskId: task.id, sessionId: 'saved-session' })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  onTestCleanup(() => { vi.useRealTimers() })
  const notifications: NotificationConstructorOptions[] = []
  class Notification extends EventEmitter {
    static isSupported() { return true }
    constructor(options: NotificationConstructorOptions) { super(); notifications.push(options) }
    show() {}
    close() {}
  }
  onTestCleanup(registerTaskNotifications(store, Notification))
  const fail = async (retryable = true, afterMs?: number) => {
    agents.active.delete(task.id)
    agents.emit('exit', {
      taskId: task.id, code: 1, cancelled: false, error: 'Provider temporarily unavailable',
      result: { taskId: task.id, issueId: issue.id, sessionId: 'saved-session', status: 'failed',
        output: '', changedFiles: [], ...(retryable ? { retry: { source: 'provider', afterMs } } : {}) }
    })
    await tick()
  }
  return { store, agents, git, task, tracker, issue, execution, finish, fail, notifications }
}

test('recovers the same claimed issue and session before finalization, then waits for review', async () => {
  const f = await setup()
  await f.fail()
  expect(f.store.getTask(f.task.id)?.status).toBe('running')
  expect(f.tracker.get(f.issue.id).status).toBe('working')
  expect(f.finish).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(3_000)
  expect(f.agents.starts).toHaveLength(2)
  expect(f.agents.starts[1]).toMatchObject({
    taskId: f.task.id, issueId: f.issue.id, resumeSessionId: 'saved-session',
    cwd: f.task.cwd, model: f.task.model, reasoningEffort: 'high'
  })
  expect(f.agents.starts[1].prompt).toContain('Continue')
  expect(f.agents.starts[1].resumeFallbackPrompt).toBeUndefined()
  expect(f.store.readEvents(f.task.id).some((event) => event.text.includes('attempt 1/3'))).toBe(true)
  f.tracker.submitForReview(f.issue.id, { checklist: [true], evidence: 'Done' })
  f.agents.finishTurn(f.task.id)
  await tick()
  expect(f.store.getTaskExecution(f.task.id)?.phase).toBe('reviewing')
  expect(f.finish).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(f.agents.starts).toHaveLength(2)
})

test('does not repeat an issue submitted just before the failure', async () => {
  const f = await setup()
  f.tracker.submitForReview(f.issue.id, { checklist: [true], evidence: 'Already done' })
  await f.fail()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(f.agents.starts).toHaveLength(1)
  expect(f.store.getTaskExecution(f.task.id)?.phase).toBe('reviewing')
  expect(f.finish).not.toHaveBeenCalled()
})

test('bounds repeated failures and leaves permanent failures paused', async () => {
  const f = await setup()
  for (let index = 0; index < 3; index++) {
    await f.fail()
    await vi.advanceTimersByTimeAsync(35_000)
  }
  expect(f.agents.starts).toHaveLength(4)
  await f.fail()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(f.agents.starts).toHaveLength(4)
  expect(f.finish).toHaveBeenCalledOnce()
  expect(f.store.getTask(f.task.id)?.status).toBe('pending')
  expect(f.tracker.get(f.issue.id).status).toBe('blocked')
})

test('does not retry an unclassified failure', async () => {
  const f = await setup()
  await f.fail(false)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(f.agents.starts).toHaveLength(1)
  expect(f.finish).toHaveBeenCalledOnce()
})

test('honors retry-after, ignores duplicate exits, and reconciles a late review submission', async () => {
  const f = await setup()
  await f.fail(true, 45_000)
  await f.fail(true, 45_000)
  await vi.advanceTimersByTimeAsync(44_000)
  expect(f.agents.starts).toHaveLength(1)
  f.tracker.submitForReview(f.issue.id, { checklist: [true], evidence: 'Submitted during disconnect' })
  await vi.advanceTimersByTimeAsync(1_000)
  expect(f.agents.starts).toHaveLength(1)
  expect(f.store.getTaskExecution(f.task.id)?.phase).toBe('reviewing')
  expect(f.finish).not.toHaveBeenCalled()
})

test('pauses instead of ignoring a retry-after beyond the recovery window', async () => {
  const f = await setup()
  await f.fail(true, 180_000)
  expect(f.finish).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(180_000)
  expect(f.agents.starts).toHaveLength(1)
})

test('does not resume a missing or superseded session', async () => {
  const f = await setup()
  f.store.updateTask(f.task.id, { sessionId: undefined })
  await f.fail()
  await vi.advanceTimersByTimeAsync(120_000)
  expect(f.agents.starts).toHaveLength(1)
  expect(f.finish).toHaveBeenCalledOnce()
})

test.each(['cancel', 'delete', 'shutdown'] as const)('invalidates pending recovery on %s', async (action) => {
  const f = await setup()
  await f.fail()
  if (action === 'cancel') await f.execution.finishTaskTurn({ taskId: f.task.id, code: null, cancelled: true })
  if (action === 'delete') {
    f.execution.stopTask(f.task.id, 'Deleted')
    f.store.deleteTaskCascade(f.task.id)
  }
  if (action === 'shutdown') f.agents.emit('closing')
  await vi.advanceTimersByTimeAsync(120_000)
  expect(f.agents.starts).toHaveLength(1)
})

for (const stage of ['working', 'submitted', 'reviewing'] as const) {
  test(`cancelling ${stage} work emits one cancelled subtask alert through orchestration`, async () => {
    const f = await setup()
    if (stage !== 'working') {
      callIssueTool(f.store, f.task.id, f.task.workspaceId!, 'anvil_submit_review', {
        id: f.issue.id, checklist: [true], evidence: 'Validated'
      })
      expect(f.notifications).toEqual([])
    }
    f.agents.active.delete(f.task.id)
    if (stage === 'reviewing') {
      await f.execution.finishTaskTurn({ taskId: f.task.id, code: 0, cancelled: false })
      expect(f.notifications.map((n) => n.title)).toEqual(['Subtask ready for review: Implement'])
    }
    f.notifications.length = 0
    await f.execution.finishTaskTurn({ taskId: f.task.id, code: null, cancelled: true })
    expect(f.notifications).toEqual([{ title: 'Subtask cancelled: Implement', body: `Task · ${f.issue.id}` }])
    expect(f.tracker.get(f.issue.id).status).toBe('blocked')
    expect(f.store.getTask(f.task.id)?.status).toBe('cancelled')
    expect(f.finish).toHaveBeenCalledOnce()
    await f.execution.finishTaskTurn({ taskId: f.task.id, code: null, cancelled: true })
    f.store.setSettings({ caffeineMode: true })
    expect(f.notifications).toHaveLength(1)
  })
}

test('permanent orchestration failure alerts blocked once without a duplicate parent pause', async () => {
  const f = await setup()
  await f.fail(false)
  expect(f.notifications).toEqual([{ title: 'Subtask blocked: Implement', body: `Task · ${f.issue.id}` }])
  expect(f.store.getTask(f.task.id)?.status).toBe('pending')
})
