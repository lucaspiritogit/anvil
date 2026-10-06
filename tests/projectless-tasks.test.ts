import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import type { Task, TaskExecutionState, TaskResultNotice } from '@anvil/protocol/types'
import { Store } from '../apps/server/src/store'
import { createHandlerRegistry } from '../apps/server/src/handler-registry'
import { registerTaskHandlers } from '../apps/server/src/handlers/tasks'
import { registerSteeringHandlers } from '../apps/server/src/handlers/steering'
import { registerReviewHandlers } from '../apps/server/src/handlers/review'
import { createTaskCompletion } from '../apps/server/src/tasks/completion'
import { registerTaskEvents } from '../apps/server/src/tasks/events'
import { registerTaskExecution } from '../apps/server/src/tasks/task-execution'
import { callIssueTool } from '../apps/server/src/issue-tools/server'
import type { TaskContext } from '../apps/server/src/tasks/context'
import { AgentProcessManager, GitDeliveryManager } from './issue-tracker-doubles'
import { onTestCleanup } from './test-cleanup'

const migrationsFolder = join(process.cwd(), 'apps/server/src/db/migrations')

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-projectless-tasks-')))
  const configFile = join(root, 'config.json')
  let store = new Store(configFile, { migrationsFolder })
  const registry = createHandlerRegistry()
  const agentProcesses = new AgentProcessManager(configFile)
  const gitDelivery = new GitDeliveryManager()
  const gitCalls = [
    vi.spyOn(gitDelivery, 'status'),
    vi.spyOn(gitDelivery, 'prepareBranch'),
    vi.spyOn(gitDelivery, 'checkoutBranch'),
    vi.spyOn(gitDelivery, 'finalizeBranch'),
    vi.spyOn(gitDelivery, 'getWorkingTreeDiff'),
    vi.spyOn(gitDelivery, 'releaseWorktree')
  ]
  const context: TaskContext = {
    store,
    agentProcesses: agentProcesses as never,
    gitDelivery: gitDelivery as never,
    send: () => {}
  }
  const events = registerTaskEvents(context)
  const rememberCompletedTask = vi.fn(async () => {})
  const promptWithProjectMemory = vi.fn(async (_projectId: string, prompt: string) => prompt)
  const completion = createTaskCompletion(context, events.recordSystemEvent, { rememberCompletedTask })
  const execution = registerTaskExecution({ ...context, recordSystemEvent: events.recordSystemEvent }, completion)
  registerTaskHandlers(registry, { ...context, ...events, ...execution, promptWithProjectMemory })
  registerSteeringHandlers(registry, { ...context, ...events, ...execution })
  registerReviewHandlers(registry, { ...context, ...events, ...execution })
  onTestCleanup(async () => {
    agentProcesses.emit('closing')
    await agentProcesses.close()
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const tick = async (): Promise<void> => {
    for (let index = 0; index < 8; index++) await new Promise<void>((resolve) => setImmediate(resolve))
  }
  const start = async (input: Record<string, unknown> = {}): Promise<Task> => {
    const task = await registry.invoke('tasks:start', { agentId: 'codex', prompt: 'Explain this idea', ...input }) as Task
    await tick()
    return store.getTask(task.id)!
  }
  return {
    root, registry, agentProcesses, gitCalls, rememberCompletedTask, promptWithProjectMemory, start, tick,
    get store() { return store },
    reopen() {
      store.close()
      store = new Store(configFile, { migrationsFolder })
      return store
    }
  }
}

test('runs tasks without a project in their own workspace directory without project tools', async () => {
  const f = fixture()
  const task = await f.start({ reasoningEffort: 'high' })
  const second = await f.start()
  const expectedCwd = join(f.store.getWorkspaceDirectory('default'), 'tasks', task.id)

  expect(task).toMatchObject({ style: 'quick', checkoutMode: 'local', deliveryStatus: 'unavailable', cwd: expectedCwd })
  expect(task.projectId).toBeUndefined()
  expect(task.branchName).toBeUndefined()
  expect(second.cwd).not.toBe(task.cwd)
  expect(existsSync(expectedCwd)).toBe(true)
  expect(f.agentProcesses.starts[0]).toMatchObject({ taskId: task.id, cwd: expectedCwd, issueTracker: false, reasoningEffort: 'high' })
  expect(f.agentProcesses.starts[0].projectPath).toBeUndefined()
  expect(f.store.getTaskExecution(task.id)).toMatchObject({ style: 'quick', projectPath: expectedCwd, parentIssueId: '', issueIds: [] })
  expect(f.registry.invoke('tasks:issues', task.id)).toBeNull()
  const snapshot = callIssueTool(f.store, task.id, task.workspaceId, 'anvil_get_task', { taskId: task.id }) as { issueSummary: { total: number } }
  expect(snapshot.issueSummary.total).toBe(0)
  expect(() => callIssueTool(f.store, task.id, task.workspaceId, 'anvil_get_plan', {})).toThrow('Task has no issue plan')
  expect(f.promptWithProjectMemory).not.toHaveBeenCalled()
  for (const gitCall of f.gitCalls) expect(gitCall).not.toHaveBeenCalled()
})

test('completes, resumes, settles and persists a task without a project', async () => {
  const f = fixture()
  const task = await f.start()
  f.store.updateTask(task.id, { sessionId: 'saved-session' })
  f.agentProcesses.finishTurn(task.id)
  await f.tick()

  expect(f.store.getTask(task.id)).toMatchObject({ status: 'succeeded', deliveryStatus: 'unavailable' })
  const notice = f.store.getTaskResultNotices()[0]
  expect(notice).toMatchObject({ taskId: task.id, workspaceId: 'default', kind: 'completed' })
  expect(notice.projectId).toBeUndefined()
  expect(f.store.getTaskExecution(task.id)?.phase).toBe('complete')
  expect(f.store.getAnalytics({ startAt: task.startedAt, endAt: task.startedAt + 1 }).breakdowns.projects)
    .toMatchObject([{ key: 'no-project', label: 'No project', taskCount: 1 }])
  await f.registry.invoke('tasks:steer', { taskId: task.id, message: 'Continue this explanation' })
  expect(f.agentProcesses.starts.at(-1)).toMatchObject({ taskId: task.id, cwd: task.cwd, resumeSessionId: 'saved-session', issueTracker: false })
  expect(f.agentProcesses.starts.at(-1).projectPath).toBeUndefined()
  f.agentProcesses.finishTurn(task.id)
  await f.tick()
  const settled = f.registry.invoke('tasks:settle', task.id) as Task
  expect(settled.settledAt).toEqual(expect.any(Number))
  expect(f.rememberCompletedTask).not.toHaveBeenCalled()
  for (const gitCall of f.gitCalls) expect(gitCall).not.toHaveBeenCalled()

  const reopened = f.reopen()
  expect(reopened.getTask(task.id)).toMatchObject({ status: 'succeeded', cwd: task.cwd, settledAt: settled.settledAt })
  expect(reopened.getTask(task.id)?.projectId).toBeUndefined()
  expect(reopened.getTaskResultNotices()[0].projectId).toBeUndefined()
  expect(reopened.getTaskExecution(task.id)?.phase).toBe('complete')
})

test('cancels and deletes a task without a project and cascades completion notices', async () => {
  const f = fixture()
  const cancelled = await f.start()
  expect(f.registry.invoke('tasks:cancel', cancelled.id)).toBe(true)
  await f.tick()
  expect(f.store.getTask(cancelled.id)).toMatchObject({ status: 'cancelled', deliveryStatus: 'unavailable' })
  expect(f.store.getTaskExecution(cancelled.id)?.phase).toBe('blocked')
  await f.registry.invoke('tasks:delete', cancelled.id)
  expect(f.store.getTask(cancelled.id)).toBeUndefined()

  const completed = await f.start()
  f.agentProcesses.finishTurn(completed.id)
  await f.tick()
  expect(f.store.getTaskResultNotices()).toHaveLength(1)
  await f.registry.invoke('tasks:delete', completed.id)
  expect(f.store.getTaskResultNotices()).toEqual([])
  for (const gitCall of f.gitCalls) expect(gitCall).not.toHaveBeenCalled()
})

test('recovers a projectless task in its saved directory and session without Git', async () => {
  const f = fixture()
  const task = await f.start({ reasoningEffort: 'high' })
  f.store.updateTask(task.id, { sessionId: 'saved-session' })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  f.agentProcesses.active.delete(task.id)
  f.agentProcesses.emit('exit', {
    taskId: task.id, code: 1, cancelled: false, error: 'Provider temporarily unavailable',
    result: { taskId: task.id, sessionId: 'saved-session', status: 'failed', output: '',
      changedFiles: [], retry: { source: 'provider' } }
  })
  await f.tick()
  expect(f.store.getTask(task.id)?.status).toBe('running')
  await vi.advanceTimersByTimeAsync(3_000)
  expect(f.agentProcesses.starts).toHaveLength(2)
  expect(f.agentProcesses.starts[1]).toMatchObject({
    taskId: task.id, cwd: task.cwd, resumeSessionId: 'saved-session', issueTracker: false, reasoningEffort: 'high'
  })
  expect(f.agentProcesses.starts[1].projectPath).toBeUndefined()
  f.agentProcesses.finishTurn(task.id)
  await f.tick()
  expect(f.store.getTask(task.id)?.status).toBe('succeeded')
  for (const gitCall of f.gitCalls) expect(gitCall).not.toHaveBeenCalled()
  vi.useRealTimers()
})

test('keeps projectless execution and notices isolated between workspaces', async () => {
  const f = fixture()
  const first = await f.start()
  f.agentProcesses.finishTurn(first.id)
  await f.tick()
  const other = f.store.createWorkspace('Other')
  f.store.selectWorkspace(other.id)
  const second = await f.start({ workspaceId: other.id })
  expect(second.cwd).toBe(join(f.store.getWorkspaceDirectory(other.id), 'tasks', second.id))
  expect(second.cwd).not.toContain(f.store.getWorkspaceDirectory('default'))
  expect(f.registry.invoke('tasks:list')).toMatchObject([{ id: second.id, workspaceId: other.id }])
  expect(f.registry.invoke('task-result-notices:list', { workspaceId: other.id })).toEqual([])
  expect(() => f.registry.invoke('task-result-notices:seen', { workspaceId: other.id, noticeId: f.store.getTaskResultNotices('default')[0].id }))
    .toThrow('Task result notice not found')
  const notices = f.registry.invoke('task-result-notices:list', { workspaceId: other.id }) as TaskResultNotice[]
  expect(notices).toEqual([])

  const sqlite = new DatabaseSync(f.store.getWorkspaceDatabasePath('default'))
  onTestCleanup(() => sqlite.close())
  sqlite.exec('PRAGMA foreign_keys = ON')
  sqlite.prepare('INSERT INTO workspaces (id, name, name_key, created_at) VALUES (?, ?, ?, ?)').run(other.id, other.name, 'other', 1)
  expect(() => sqlite.prepare(`INSERT INTO task_result_notices
    (id, workspace_id, project_id, task_id, result_version, kind, created_at)
    VALUES (?, ?, NULL, ?, ?, ?, ?)`).run('invalid-workspace', other.id, first.id, 2, 'completed', 1))
    .toThrow(/FOREIGN KEY constraint failed/)
})

test('rejects project-dependent settings before creating a projectless task', async () => {
  const f = fixture()
  for (const input of [
    { style: 'work' },
    { checkoutMode: 'worktree' },
    { parentTaskId: 'parent' },
    { startBase: 'main' },
    { fileReferences: ['src/main.ts'] },
    { reviewPolicy: 'review_at_task_end' }
  ]) {
    await expect(f.registry.invoke('tasks:start', { agentId: 'codex', prompt: 'Invalid task', ...input })).rejects.toThrow(/require|Only Work tasks/)
  }
  await expect(f.registry.invoke('tasks:start', { projectId: 'missing', agentId: 'codex', prompt: 'Invalid task' })).rejects.toThrow('Project not found')
  expect(f.store.getTasks()).toEqual([])
  expect(f.agentProcesses.starts).toEqual([])
})

test('preserves project tasks, executions, events, comments, stack references and notices when migrating', () => {
  const root = mkdtempSync(join(tmpdir(), 'anvil-projectless-migration-'))
  const olderMigrationsFolder = join(root, 'older-migrations')
  mkdirSync(olderMigrationsFolder)
  const migrationDirectories = readdirSync(migrationsFolder).sort()
  const projectlessMigration = migrationDirectories.findIndex((directory) => directory.endsWith('_furry_black_bolt'))
  for (const migrationDirectory of migrationDirectories.slice(0, projectlessMigration)) {
    cpSync(join(migrationsFolder, migrationDirectory), join(olderMigrationsFolder, migrationDirectory), { recursive: true })
  }
  for (const migrationDirectory of migrationDirectories.slice(projectlessMigration + 1)) {
    cpSync(join(migrationsFolder, migrationDirectory), join(olderMigrationsFolder, `${migrationDirectory}_before_projectless`), { recursive: true })
  }
  const configFile = join(root, 'config.json')
  let store = new Store(configFile, { migrationsFolder: olderMigrationsFolder })
  onTestCleanup(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  store.addProject({ id: 'project', name: 'Project', path: join(root, 'project'), createdAt: 1,
    monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
  const parent = store.addTask({ id: randomUUID(), projectId: 'project', style: 'work', checkoutMode: 'worktree',
    agentId: 'codex', agentLabel: 'Codex', title: 'Parent', prompt: 'Parent task', cwd: join(root, 'project'),
    status: 'running', startedAt: 1, deliveryStatus: 'working', branchName: 'task/parent', baseCommit: 'base',
    inputTokens: 1, outputTokens: 2, cachedTokens: 0, totalTokens: 3, costUsd: null, filesChanged: 1, additions: 1, deletions: 0 })
  store.updateTask(parent.id, { status: 'succeeded', deliveryStatus: 'reviewable', headCommit: 'head' })
  const child = store.addTask({ ...parent, id: randomUUID(), title: 'Child', parentTaskId: parent.id, status: 'pending',
    deliveryStatus: 'reviewable', branchName: 'task/child', headCommit: 'child-head' })
  const state: TaskExecutionState = { taskId: parent.id, projectPath: parent.cwd, style: 'work', parentIssueId: '',
    phase: 'complete', issueIds: [], currentIssueId: null, error: null, reasoningEffort: 'high' }
  store.saveTaskExecution(state)
  store.addComment({ id: 'comment', taskId: parent.id, file: 'src/app.ts', side: 'additions', lineNumber: 1,
    body: 'Keep this comment', createdAt: 2, sentAt: null })
  store.appendEvent({ id: 'event', taskId: parent.id, ts: 2, stream: 'stdout', kind: 'output', category: 'message', text: 'Keep this output' })
  const notice = store.getTaskResultNotices()[0]
  store.close()
  store = new Store(configFile, { migrationsFolder })

  expect(store.getTask(parent.id)).toMatchObject({ projectId: 'project', branchName: 'task/parent', baseCommit: 'base', headCommit: 'head' })
  expect(store.getTask(child.id)).toMatchObject({ parentTaskId: parent.id, branchName: 'task/child' })
  expect(store.getTaskExecution(parent.id)).toEqual(state)
  expect(store.getComments(parent.id)).toMatchObject([{ id: 'comment', body: 'Keep this comment' }])
  expect(store.readEvents(parent.id)).toMatchObject([{ id: 'event', text: 'Keep this output' }])
  expect(store.getTaskResultNotices()).toMatchObject([{ id: notice.id, taskId: parent.id }])
})
