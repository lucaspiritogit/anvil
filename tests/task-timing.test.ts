import { expect, test, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/main/store'
import { resumeTaskTurn } from '../src/main/tasks/resume'
import { createTaskCompletion } from '../src/main/tasks/completion'
import { registerTaskExecution } from '../src/main/tasks/task-execution'
import type { TaskContext } from '../src/main/tasks/context'
import { isTaskWorking, taskWorkingTimeMs } from '../src/shared/task-timing'
import type { DeliveryStatus, Task, TaskExecutionState, TaskStatus } from '../src/shared/types'
import { AgentProcessManager, GitDeliveryManager } from './issue-tracker-doubles'
import { migrationsFolder } from './migration-fixture'
import { onTestCleanup } from './test-cleanup'

function fixture() {
  let now = 1_000
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  onTestCleanup(() => clock.mockRestore())
  const directory = mkdtempSync(join(tmpdir(), 'anvil-timing-'))
  onTestCleanup(() => rmSync(directory, { recursive: true, force: true }))
  const databasePath = join(directory, 'config.json')
  const store = new Store(databasePath, { migrationsFolder })
  onTestCleanup(() => store.close())
  store.addProject({ id: 'project', name: 'Project', path: directory, createdAt: 0,
    monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
  const add = (patch: Partial<Task> = {}) => store.addTask({
    id: 'task', workspaceId: 'default', projectId: 'project', title: 'Task', prompt: 'Task',
    agentId: 'codex', agentLabel: 'Codex', cwd: directory,
    status: 'running', deliveryStatus: 'working', startedAt: 1,
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null,
    filesChanged: 0, additions: 0, deletions: 0, ...patch
  })
  const execution = (patch: Partial<TaskExecutionState> = {}) => store.saveTaskExecution({
    taskId: 'task', projectPath: directory, parentIssueId: 'parent',
    phase: 'working', currentIssueId: 'first', issueIds: ['first', 'second'], error: null, ...patch
  })
  return { store, add, execution, databasePath, at: (value: number) => { now = value } }
}

test.each(['working', 'unavailable'] as const)('measures repeated work and review intervals with %s delivery', (deliveryStatus) => {
  const { store, add, execution, at } = fixture()
  expect(add({ deliveryStatus })).toMatchObject({ workingTimeMs: 0, workingStartedAt: 1_000, startedAt: 1 })
  execution()
  at(4_000)
  execution({ phase: 'reviewing' })
  expect(store.getTask('task')).toMatchObject({ status: 'running', deliveryStatus, workingTimeMs: 3_000 })
  expect(store.getTask('task')?.workingStartedAt).toBeUndefined()
  at(100_000)
  execution({ phase: 'reviewing' })
  store.updateTask('task', { title: 'Still reviewing' })
  expect(taskWorkingTimeMs(store.getTask('task')!, 100_000)).toBe(3_000)
  // Approval may queue the next issue before the scheduler claims it.
  execution({ currentIssueId: null })
  at(110_000)
  expect(store.getTask('task')?.workingStartedAt).toBeUndefined()
  execution({ currentIssueId: 'second' })
  at(112_000)
  execution({ phase: 'reviewing', currentIssueId: 'second' })
  expect(store.getTask('task')?.workingTimeMs).toBe(5_000)
  at(200_000)
  execution({ phase: 'recovering', currentIssueId: 'second' })
  at(201_000)
  execution({ phase: 'reviewing', currentIssueId: 'second' })
  expect(store.getTask('task')?.workingTimeMs).toBe(6_000)
  at(300_000)
  store.transaction(() => {
    execution({ phase: 'complete', currentIssueId: null })
    store.updateTask('task', { status: 'succeeded', deliveryStatus: deliveryStatus === 'working' ? 'reviewable' : 'unavailable', endedAt: 300_000 })
  })
  expect(store.getTask('task')?.workingTimeMs).toBe(6_000)
  expect(store.getTask('task')?.workingStartedAt).toBeUndefined()
  at(400_000)
  // Ordinary follow-ups retain the completed issue plan.
  store.updateTask('task', { status: 'running', deliveryStatus, endedAt: undefined })
  at(402_000)
  const finished = store.updateTask('task', { status: 'succeeded', endedAt: 402_000 })!
  expect(finished.workingTimeMs).toBe(8_000)
  at(500_000)
  expect(store.updateTask('task', { status: 'succeeded', endedAt: 500_000 })?.workingTimeMs).toBe(8_000)
})

test('task and execution writes publish committed timing together and roll back atomically', () => {
  const { store, add, execution, at } = fixture()
  add()
  execution()
  const snapshots: Task[] = []
  const unsubscribe = store.subscribeActivity(() => snapshots.push(store.getTask('task')!))
  onTestCleanup(unsubscribe)
  at(2_000)
  execution({ phase: 'reviewing' })
  expect(snapshots).toHaveLength(1)
  expect(snapshots[0].workingTimeMs).toBe(1_000)
  expect(snapshots[0].workingStartedAt).toBeUndefined()
  at(5_000)
  expect(() => store.transaction(() => {
    execution()
    throw new Error('rollback')
  })).toThrow('rollback')
  expect(snapshots).toHaveLength(1)
  expect(store.getTaskExecution('task')?.phase).toBe('reviewing')
  expect(store.getTask('task')?.workingTimeMs).toBe(1_000)
  expect(store.getTask('task')?.workingStartedAt).toBeUndefined()
})

test('duplicate exit notifications leave review and completed measurements unchanged', async () => {
  const { store, add, execution, at } = fixture()
  add({ deliveryStatus: 'unavailable' })
  at(2_000)
  execution({ phase: 'reviewing' })
  const agentProcesses = new AgentProcessManager()
  onTestCleanup(() => agentProcesses.close())
  const context: TaskContext = {
    store, agentProcesses: agentProcesses as unknown as TaskContext['agentProcesses'],
    gitDelivery: new GitDeliveryManager() as unknown as TaskContext['gitDelivery'], send: () => {}
  }
  const recordSystemEvent = () => {}
  const completion = createTaskCompletion(context, recordSystemEvent, { rememberCompletedTask: async () => {} })
  const scheduler = registerTaskExecution({ ...context, recordSystemEvent }, completion)
  const exit = { taskId: 'task', code: 0, cancelled: false }
  at(100_000)
  await scheduler.finishTaskTurn(exit)
  await scheduler.finishTaskTurn(exit)
  expect(store.getTask('task')?.workingTimeMs).toBe(1_000)
  expect(store.getTask('task')?.workingStartedAt).toBeUndefined()
  // A completed plan's follow-up is still a real working turn.
  execution({ phase: 'complete', currentIssueId: null })
  at(102_000)
  await scheduler.finishTaskTurn(exit)
  expect(store.getTask('task')?.status).toBe('succeeded')
  expect(store.getTask('task')?.workingTimeMs).toBe(3_000)
  at(200_000)
  await scheduler.finishTaskTurn(exit)
  expect(store.getTask('task')?.workingTimeMs).toBe(3_000)
})

const pausedStates: Partial<Task>[] = [
  ...(['pending', 'succeeded', 'failed', 'cancelled'] as TaskStatus[]).map((status) => ({ status })),
  ...(['preparing', 'finalizing', 'did_not_commit', 'reviewable', 'approved', 'no_changes', 'agent_failed', 'failed'] as DeliveryStatus[])
    .map((deliveryStatus) => ({ deliveryStatus }))
]

test.each(pausedStates)('pauses and resumes around non-working task state %j', (patch) => {
  const { store, add, at } = fixture()
  add(patch)
  expect(store.getTask('task')?.workingStartedAt).toBeUndefined()
  at(2_000)
  store.updateTask('task', { status: 'running', deliveryStatus: 'working' })
  at(3_000)
  expect(store.updateTask('task', patch)?.workingTimeMs).toBe(1_000)
  at(10_000)
  const paused = store.updateTask('task', patch)!
  expect(paused.workingTimeMs).toBe(1_000)
  expect(paused.workingStartedAt).toBeUndefined()
  at(20_000)
  store.updateTask('task', { status: 'running', deliveryStatus: 'working' })
  expect(taskWorkingTimeMs(store.getTask('task')!, 21_000)).toBe(2_000)
})

test('execution blocks pause and stale task snapshots cannot overwrite measured time', () => {
  const { store, add, execution, at } = fixture()
  const stale = add()
  execution({ phase: 'planning', currentIssueId: null })
  at(2_000)
  store.updateTask('task', { totalTokens: 20 })
  at(3_000)
  execution({ phase: 'blocked' })
  at(100_000)
  const paused = store.updateTask('task', stale)!
  expect(paused.workingTimeMs).toBe(2_000)
  expect(paused.workingStartedAt).toBeUndefined()
  expect(isTaskWorking(paused, store.getTaskExecution('task'))).toBe(false)
})

test.each([true, false])('failed resumed dispatch restores totals and emitted snapshots (managed: %s)', async (managed) => {
  const { store, add, execution, at } = fixture()
  add({ deliveryStatus: managed ? 'working' : 'unavailable', ...(managed ? { branchName: 'task-branch' } : {}) })
  at(2_000)
  execution({ phase: 'reviewing' })
  at(100_000)
  const agentProcesses = new AgentProcessManager()
  onTestCleanup(() => agentProcesses.close())
  agentProcesses.startResumed = async () => {
    at(105_000)
    store.updateTask('task', { totalTokens: 25 })
    throw new Error('Dispatch failed')
  }
  const snapshots: Task[] = []
  const context: TaskContext = {
    store,
    agentProcesses: agentProcesses as unknown as TaskContext['agentProcesses'],
    gitDelivery: new GitDeliveryManager() as unknown as TaskContext['gitDelivery'],
    send: (_channel, value) => { snapshots.push(value as Task) }
  }
  await expect(resumeTaskTurn(context, {
    check: () => store.getTask('task')!, validate: () => {}, prompt: () => 'Rework',
    resumeExecution: () => execution({ phase: 'recovering' })
  })).rejects.toThrow('Dispatch failed')
  expect(store.getTaskExecution('task')?.phase).toBe('reviewing')
  expect(store.getTask('task')).toMatchObject({ workingTimeMs: 1_000, totalTokens: 25 })
  expect(store.getTask('task')?.workingStartedAt).toBeUndefined()
  expect(snapshots.at(-1)).toEqual(store.getTask('task'))
  at(200_000)
  agentProcesses.startResumed = async () => {}
  const resumed = await resumeTaskTurn(context, {
    check: () => store.getTask('task')!, validate: () => {}, prompt: () => 'Rework',
    resumeExecution: () => execution({ phase: 'recovering' })
  })
  expect(resumed).toMatchObject({ workingTimeMs: 1_000, workingStartedAt: 200_000 })
})

test('clean shutdown saves active work and restart excludes all app downtime', () => {
  const { store, add, execution, at, databasePath } = fixture()
  add()
  execution()
  at(3_000)
  store.close()
  at(100_000)
  const recovered = new Store(databasePath, { migrationsFolder })
  onTestCleanup(() => recovered.close())
  expect(recovered.getTask('task')).toMatchObject({ workingTimeMs: 2_000, status: 'pending' })
  expect(recovered.getTask('task')?.workingStartedAt).toBeUndefined()
  expect(recovered.getTaskExecution('task')?.phase).toBe('blocked')
  recovered.saveTaskExecution({ ...recovered.getTaskExecution('task')!, phase: 'recovering' })
  recovered.updateTask('task', { status: 'running', deliveryStatus: 'working', endedAt: undefined })
  at(101_000)
  recovered.saveTaskExecution({ ...recovered.getTaskExecution('task')!, phase: 'reviewing' })
  recovered.close()
  at(500_000)
  const reviewed = new Store(databasePath, { migrationsFolder })
  onTestCleanup(() => reviewed.close())
  expect(reviewed.getTask('task')?.workingTimeMs).toBe(3_000)
  expect(reviewed.getTask('task')?.workingStartedAt).toBeUndefined()
  expect(reviewed.getTaskExecution('task')?.phase).toBe('reviewing')
})

test('crash recovery keeps persisted checkpoints and discards the interval with an unknown end', () => {
  const { store, add, execution, at, databasePath } = fixture()
  add()
  execution()
  at(2_000)
  store.updateTask('task', { totalTokens: 5 })
  const workspaceDatabase = store.getWorkspaceDatabasePath('default')
  store.close()
  // Reproduce the on-disk open interval left by an abrupt process exit.
  const database = new Database(workspaceDatabase)
  try {
    database.prepare('UPDATE tasks SET working_started_at = 2000 WHERE id = ?').run('task')
  } finally { database.close() }
  at(1_000_000)
  const recovered = new Store(databasePath, { migrationsFolder })
  onTestCleanup(() => recovered.close())
  expect(recovered.getTask('task')?.workingTimeMs).toBe(1_000)
  expect(recovered.getTask('task')?.workingStartedAt).toBeUndefined()
})

test('a backwards clock never subtracts measured work or counts the same interval twice', () => {
  const { store, add, at } = fixture()
  add()
  at(3_000)
  store.updateTask('task', { title: 'Checkpoint' })
  at(2_000)
  expect(store.updateTask('task', {})?.workingTimeMs).toBe(2_000)
  at(4_000)
  expect(store.updateTask('task', { status: 'cancelled' })?.workingTimeMs).toBe(3_000)
})
