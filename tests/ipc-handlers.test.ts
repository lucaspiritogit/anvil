import { onTestCleanup } from './test-cleanup'
import { WallpaperLibrary } from '../src/server/wallpapers'
import { rendererEvent, rendererIpc } from './renderer-fixture'
import { test, expect, vi } from 'vitest'
import { pngWithDimensions } from './image-fixtures'
import { TaskImageStorage } from '../src/server/task-image-storage'
import { taskImages } from './task-image-fixture'
import { MERGE_CONFLICT_MAX_FILE_BYTES, TASK_IMAGE_LIMITS } from '../src/shared/types'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { taskState } from './task-state'
import type { AgentProcessManager as RealAgentProcessManager } from '../src/server/agents/process-manager'
import { agentRebasePrompt, mergeConflictRepairPrompt } from '../src/server/agents/task-prompts'
import type { GitDeliveryManager as RealGitDeliveryManager } from '../src/server/git'
import { registerAgentHandlers } from '../src/server/handlers/agents'
import { registerGitHubHandlers } from '../src/server/handlers/github'
import { GitHubClient } from '../src/server/github-client'
import { GitHubCredentials } from '../src/server/github-credentials'
import { registerProjectHandlers } from '../src/server/handlers/projects'
import { registerRebaseHandlers } from '../src/server/handlers/rebase'
import { registerReviewHandlers } from '../src/server/handlers/review'
import { registerTaskHandlers } from '../src/server/handlers/tasks'
import { registerSteeringHandlers } from '../src/server/handlers/steering'
import { registerWorkspaceHandlers } from '../src/server/handlers/workspaces'
import { registerSettingsHandlers } from '../src/server/handlers/settings'
import { createTaskMemory } from '../src/server/memory/task-memory'
import { createTaskCompletion } from '../src/server/tasks/completion'
import { registerTaskEvents } from '../src/server/tasks/events'
import { registerTaskExecution } from '../src/server/tasks/task-execution'
import { titleFor } from '../src/server/tasks/task-title'
import { withTaskOperation } from '../src/server/tasks/operations'
import { callIssueTool } from '../src/server/issue-tools/server'
import { Store } from '../src/server/store'
import { TaskIssues } from '../src/server/tasks/task-issues'
import type { Project, ProjectFileList, RebaseStep, Task, TaskComment, TaskEvent } from '../src/shared/types'
import { AgentProcessManager, GitDeliveryManager, handlers, testHome, shell, dialog } from './issue-tracker-doubles'

function setupIpc(preparePrompt?: (projectId: string, prompt: string) => Promise<string>) {
  const databaseFile = join(testHome, `ipc-${randomUUID()}`, 'config.json')
  const store = new Store(databaseFile, { migrationsFolder: join(process.cwd(), 'src/server/db/migrations') })
  onTestCleanup(() => store.close())
  const tasks = { get: (id: string) => store.getTask(id), has: (id: string) => !!store.getTask(id) }
  const trackers = { get: (id: string) => taskState(store, id) }
  const events: TaskEvent[] = []
  const notifications: { channel: string; payload: unknown }[] = []
  const project: Project = {
    id: 'project', name: 'Project', path: testHome, createdAt: 0,
    monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github'
  }
  store.addProject(project)
  const agentProcesses = new AgentProcessManager(databaseFile)
  onTestCleanup(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await agentProcesses.close()
  })
  const gitDelivery = new GitDeliveryManager()
  const rebaseCalls: unknown[][] = []
  const mergeCalls: unknown[][] = []
  const mergeConflictCalls: { operation: string; args: unknown[] }[] = []
  const pushCalls: unknown[][] = []
  const mergeState = {
    conflict: false,
    validationFailure: false,
    finish: undefined as (() => void) | undefined,
    files: [{
      path: 'src/conflicted.ts', status: 'both_modified' as const, stages: [1, 2, 3] as (1 | 2 | 3)[], support: 'text' as const,
      contents: '<<<<<<< HEAD\ntarget\n=======\nsource\n>>>>>>> task\n', contentsHash: '1'.repeat(64)
    }]
  }
  onTestCleanup(() => { mergeState.finish?.() })
  const delivery = Object.assign(gitDelivery, {
    async getPullRequestPreview() {
      return { sourceBranch: 'task', targetBranch: 'main', sourceCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40), remoteTargetCommit: 'c'.repeat(40), repository: 'developer/project', remote: 'origin', commitCount: 2 }
    },
    async pushPullRequestBranch(...args: unknown[]) { pushCalls.push(args) },
    async merge(...args: unknown[]) {
      mergeCalls.push(args)
      if (mergeState.conflict) return {
        status: 'conflicted', repositoryRoot: testHome, mergeHeadCommit: GitDeliveryManager.currentHeadCommit(),
        conflictedFiles: ['src/conflicted.ts']
      }
      await new Promise<void>((resolve) => { mergeState.finish = resolve })
      return { status: 'merged', commit: 'd'.repeat(40) }
    },
    async validateMergeConflict(_path: string, conflict: Task['mergeConflict']) {
      if (mergeState.validationFailure) throw new Error('The paused merge no longer matches this task.')
      return conflict?.conflictedFiles ?? []
    },
    async getMergeConflict(...args: unknown[]) {
      mergeConflictCalls.push({ operation: 'load', args })
      const conflict = args[1] as NonNullable<Task['mergeConflict']>
      return { id: conflict.id, taskId: conflict.taskId, sourceBranch: conflict.sourceBranch, targetBranch: conflict.targetBranch, requestedAction: conflict.requestedAction, files: mergeState.files, canComplete: mergeState.files.length === 0 }
    },
    async saveMergeConflictFile(...args: unknown[]) {
      mergeConflictCalls.push({ operation: 'save', args })
      const conflict = args[1] as NonNullable<Task['mergeConflict']>
      const contents = args[3] as string
      mergeState.files = contents.includes('<<<<<<<') ? [{ ...mergeState.files[0], contents, contentsHash: '2'.repeat(64) }] : []
      return { id: conflict.id, taskId: conflict.taskId, sourceBranch: conflict.sourceBranch, targetBranch: conflict.targetBranch, requestedAction: conflict.requestedAction, files: mergeState.files, canComplete: mergeState.files.length === 0 }
    },
    async completeMergeConflict(...args: unknown[]) {
      mergeConflictCalls.push({ operation: 'complete', args })
      if (mergeState.files.length) throw new Error('Resolve all merge conflicts before completing the merge')
      return 'e'.repeat(40)
    },
    async abortMergeConflict(...args: unknown[]) {
      mergeConflictCalls.push({ operation: 'abort', args })
    },
    async getPushPreview(_path: string, targetBranch: string) {
      return {
        targetBranch, targetCommit: 'b'.repeat(40), remote: 'origin',
        remoteTargetCommit: 'c'.repeat(40), remoteUrlHash: 'f'.repeat(64)
      }
    },
    async push(...args: unknown[]) { pushCalls.push(args) },
    async rebase(...args: unknown[]) {
      rebaseCalls.push(args)
      return { headCommit: 'rebased', filesChanged: 0, additions: 0, deletions: 0, commits: [] }
    }
  })
  const context = {
    store,
    agentProcesses: agentProcesses as unknown as RealAgentProcessManager,
    gitDelivery: delivery as unknown as RealGitDeliveryManager,
    send: (channel: string, payload: unknown) => {
      notifications.push({ channel, payload })
      if (channel === 'task:event') events.push(payload as TaskEvent)
    }
  }
  const taskEvents = registerTaskEvents(context)
  const memory = createTaskMemory(context)
  const completion = createTaskCompletion(context, taskEvents.recordSystemEvent, memory)
  const execution = registerTaskExecution({ ...context, recordSystemEvent: taskEvents.recordSystemEvent }, completion)
  const reviewContext = { ...context, ...execution, recordSystemEvent: taskEvents.recordSystemEvent, requireFinishedTask: execution.requireFinishedTask }
  registerTaskHandlers(rendererIpc, { ...context, ...taskEvents, ...execution, promptWithProjectMemory: preparePrompt ?? memory.promptWithProjectMemory })
  registerSteeringHandlers(rendererIpc, { ...context, ...taskEvents, ...execution })
  registerReviewHandlers(rendererIpc, reviewContext)
  const credentials = new GitHubCredentials(join(testHome, 'github-token.enc'), {
    isEncryptionAvailable: () => true,
    encryptString: () => Buffer.from('encrypted'),
    decryptString: () => 'test-token'
  })
  const client = new GitHubClient(async (url, options) => {
    if (String(url).endsWith('/user')) return Response.json({ type: 'User', login: 'developer' })
    if (options?.method !== 'POST') return Response.json([])
    const body = JSON.parse(options.body as string)
    return Response.json({ number: 7, html_url: 'https://github.com/developer/project/pull/7', title: body.title, body: body.body, user: { login: 'developer' }, head: { ref: body.head }, base: { ref: body.base } }, { status: 201 })
  })
  let prRefreshes = 0
  let credentialRefreshes = 0
  registerGitHubHandlers(rendererIpc, {
    ...reviewContext, credentials, client,
    refreshPullRequests: () => { prRefreshes += 1 },
    githubCredentialsChanged: () => { credentialRefreshes += 1 }
  })
  registerRebaseHandlers(rendererIpc, reviewContext)
  registerWorkspaceHandlers(rendererIpc, store, context.send)
  registerSettingsHandlers(rendererIpc, context.store, new WallpaperLibrary(testHome))
  registerAgentHandlers(rendererIpc, store)
  registerProjectHandlers(rendererIpc, { ...context, stopTask: execution.stopTask, deferTaskCleanup: execution.deferTaskCleanup, skipTaskCleanup: execution.skipTaskCleanup })
  const call = (name: string, input?: unknown): any => handlers.get(name)!(rendererEvent, name === 'settings:set' ? { workspaceId: 'default', patch: input } : input)
  const tick = async (): Promise<void> => {
    for (let index = 0; index < 8; index++) await new Promise((resolve) => setImmediate(resolve))
  }

  return {
    databaseFile, taskEvents, store, tasks, trackers, events, notifications, project, agentProcesses,
    gitDelivery, delivery, rebaseCalls, mergeCalls, mergeConflictCalls, pushCalls, mergeState, memory,
    credentials, client, call, tick,
    get prRefreshes() { return prRefreshes },
    get credentialRefreshes() { return credentialRefreshes }
  }
}

test('runs unattended issue reviews and stops at final task review', async () => {
  const { store, trackers, events, project, agentProcesses, call, tick } = setupIpc()
  const task: Task = await call('tasks:start', {
    projectId: project.id,
    agentId: 'codex',
    prompt: 'Complete this task unattended',
    reviewPolicy: 'review_at_task_end'
  })
  await tick()
  const issue = {
    key: 'first', title: 'First change', description: 'Make the first change', labels: [],
    priority: 'medium' as const, dependencies: [], checklist: ['Verify change'], validation: 'Run focused test'
  }
  agentProcesses.plan(task.id, [issue, { ...issue, key: 'second', title: 'Second change', dependencies: ['first'] }])
  await tick()

  const firstIssueId = store.getTaskExecution(task.id)!.currentIssueId!
  callIssueTool(store, task.id, task.workspaceId, 'anvil_submit_review', {
    id: firstIssueId,
    checklist: [true],
    evidence: 'Focused test passed'
  })
  agentProcesses.finishTurn(task.id, 'First change ready for review')
  await tick()

  expect(trackers.get(task.id)!.items.find((item) => item.id === firstIssueId)?.status).toBe('complete')
  expect(store.getTaskExecution(task.id)).toMatchObject({ phase: 'working' })
  const secondIssueId = store.getTaskExecution(task.id)!.currentIssueId!
  expect(secondIssueId).not.toBe(firstIssueId)
  expect(agentProcesses.isRunning(task.id)).toBe(true)

  callIssueTool(store, task.id, task.workspaceId, 'anvil_submit_review', {
    id: secondIssueId,
    checklist: [true],
    evidence: 'Focused test passed'
  })
  agentProcesses.finishTurn(task.id, 'Second change ready for review')
  await tick()

  expect(trackers.get(task.id)!.items.find((item) => item.id === secondIssueId)?.status).toBe('complete')
  expect(store.getTaskExecution(task.id)?.phase).toBe('complete')
  expect(store.getTask(task.id)).toMatchObject({
    reviewPolicy: 'review_at_task_end',
    status: 'succeeded',
    deliveryStatus: 'reviewable'
  })
  expect(events.filter((event) => event.text.includes('Unattended review policy accepted issue'))).toHaveLength(2)

  const commentedTask: Task = await call('tasks:start', {
    projectId: project.id,
    agentId: 'codex',
    prompt: 'Pause unattended work when comments exist',
    reviewPolicy: 'review_at_task_end'
  })
  await tick()
  agentProcesses.plan(commentedTask.id, [issue])
  await tick()
  const commentedIssueId = store.getTaskExecution(commentedTask.id)!.currentIssueId!
  callIssueTool(store, commentedTask.id, commentedTask.workspaceId, 'anvil_submit_review', {
    id: commentedIssueId,
    checklist: [true],
    evidence: 'Focused test passed'
  })
  store.addComment({
    id: randomUUID(),
    taskId: commentedTask.id,
    file: 'src/change.ts',
    side: 'additions',
    lineNumber: 1,
    body: 'Review this before continuing',
    createdAt: Date.now(),
    sentAt: null
  })
  agentProcesses.finishTurn(commentedTask.id, 'Commented change ready for review')
  await tick()

  expect(store.getTaskExecution(commentedTask.id)).toMatchObject({
    phase: 'reviewing',
    currentIssueId: commentedIssueId
  })
  expect(trackers.get(commentedTask.id)!.items.find((item) => item.id === commentedIssueId)?.status).toBe('review')
})

test('persists task ownership before preparation and retains it when selection changes', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  onTestCleanup(() => release())
  const { store, call, project, tick, agentProcesses } = setupIpc(async (_projectId, prompt) => {
    await gate
    return prompt
  })
  const work = store.createWorkspace('Work')
  const personal = store.createWorkspace('Personal')
  store.addProject(project, work.id)
  store.selectWorkspace(work.id)
  const pending = call('tasks:start', { workspaceId: work.id, projectId: project.id, agentId: 'codex', prompt: 'Work task' })
  expect(store.getTasks(work.id)).toHaveLength(1)
  expect(agentProcesses.starts).toHaveLength(0)
  store.selectWorkspace(personal.id)
  expect(call('tasks:list')).toEqual([])
  await expect(call('tasks:start', { workspaceId: work.id, projectId: project.id, agentId: 'codex', prompt: 'Stale request' })).rejects.toThrow(/Workspace changed/)
  expect(store.getTasks()).toHaveLength(1)
  release()
  const task: Task = await pending
  await tick()
  expect(task.workspaceId).toBe(work.id)
  expect(agentProcesses.starts[0].workspace.workspaceId).toBe(work.id)
  agentProcesses.emit('usage', { taskId: task.id, inputTokens: 2, outputTokens: 1, cachedTokens: 0, totalTokens: 3, costUsd: null })
  expect(store.getTask(task.id)?.totalTokens).toBe(3)
  expect(call('tasks:list')).toEqual([])
  store.addProject(project, work.id)
  store.selectWorkspace(work.id)
  expect(call('tasks:list').map((entry: Task) => entry.id)).toEqual([task.id])
})

test('validates and routes local checkout and selected-base Work tasks', async () => {
  const { store, call, project, tick, agentProcesses, gitDelivery } = setupIpc()
  const prepare = vi.spyOn(gitDelivery, 'prepareBranch')
  const resolveBase = vi.spyOn(gitDelivery, 'resolveWorktreeBase')

  expect(() => call('tasks:start', { projectId: project.id, agentId: 'codex', prompt: 'Invalid', checkoutMode: 'shared' }))
    .toThrow(/checkoutMode/)
  await expect(call('tasks:start', { projectId: project.id, agentId: 'codex', prompt: 'Invalid', checkoutMode: 'local', startBase: 'origin/main' }))
    .rejects.toThrow(/cannot choose a worktree start base/)
  await expect(call('tasks:start', { projectId: project.id, agentId: 'codex', prompt: 'Invalid', checkoutMode: 'local', parentTaskId: 'parent' }))
    .rejects.toThrow(/Stacked tasks must use a new worktree/)
  await expect(call('tasks:start', { projectId: project.id, agentId: 'codex', prompt: 'Invalid', parentTaskId: 'parent', startBase: 'origin/main' }))
    .rejects.toThrow(/start from their parent task/)

  const local: Task = await call('tasks:start', {
    projectId: project.id, agentId: 'codex', prompt: 'Use this checkout', checkoutMode: 'local'
  })
  await tick()
  expect(store.getTask(local.id)).toMatchObject({ checkoutMode: 'local', cwd: project.path, deliveryStatus: 'unavailable' })
  expect(agentProcesses.starts.at(-1)).toMatchObject({ taskId: local.id, cwd: project.path, projectPath: project.path })
  expect(store.getTaskExecution(local.id)).toMatchObject({ phase: 'planning', projectPath: project.path })
  expect(agentProcesses.starts.at(-1).prompt).toContain("project's existing checkout")
  expect(prepare).not.toHaveBeenCalled()

  const concurrentLocal: Task = await call('tasks:start', {
    projectId: project.id, agentId: 'codex', prompt: 'Concurrent local task', checkoutMode: 'local'
  })
  const concurrentQuick: Task = await call('tasks:start', {
    projectId: project.id, agentId: 'codex', prompt: 'Concurrent Quick task', style: 'quick', checkoutMode: 'local'
  })
  await tick()
  expect(store.getTask(concurrentLocal.id)).toMatchObject({ cwd: project.path, checkoutMode: 'local' })
  expect(store.getTask(concurrentQuick.id)).toMatchObject({ cwd: project.path, checkoutMode: 'local' })
  await expect(call('projects:checkout', { projectId: project.id, branchName: 'main' }))
    .rejects.toThrow(/active task using this project checkout/)

  const finalize = vi.spyOn(gitDelivery, 'finalizeBranch')
  agentProcesses.plan(local.id, [{
    key: 'local-work', title: 'Local work', description: 'Work in the current checkout', labels: [], priority: 'medium',
    dependencies: [], checklist: ['Verify local work'], validation: 'Run focused test'
  }])
  await tick()
  const localIssue = store.getTaskExecution(local.id)!.currentIssueId!
  expect(agentProcesses.starts.at(-1)).toMatchObject({ taskId: local.id, issueId: localIssue, cwd: project.path })
  expect(agentProcesses.starts.at(-1).prompt).toContain("project's existing checkout")
  callIssueTool(store, local.id, local.workspaceId, 'anvil_submit_review', {
    id: localIssue, checklist: [true], evidence: 'Local workflow passed'
  })
  agentProcesses.finishTurn(local.id, 'Local work ready')
  await tick()
  expect(store.getTaskExecution(local.id)).toMatchObject({ phase: 'reviewing', currentIssueId: localIssue })
  expect(finalize).not.toHaveBeenCalled()
  await call('tasks:approve-issue', { taskId: local.id, issueId: localIssue, headCommit: null })
  await tick()
  expect(store.getTask(local.id)).toMatchObject({ status: 'succeeded', checkoutMode: 'local', deliveryStatus: 'unavailable' })
  expect(finalize).not.toHaveBeenCalled()
  const releaseWorktree = vi.spyOn(gitDelivery, 'releaseWorktree')
  await call('tasks:delete', local.id)
  expect(releaseWorktree).not.toHaveBeenCalled()
  const deletedWhileRunning: Task = await call('tasks:start', {
    projectId: project.id, agentId: 'codex', prompt: 'Delete this local task', checkoutMode: 'local'
  })
  await tick()
  await call('tasks:delete', deletedWhileRunning.id)
  await tick()
  expect(store.getTask(deletedWhileRunning.id)).toBeUndefined()
  expect(releaseWorktree).not.toHaveBeenCalled()

  const based: Task = await call('tasks:start', {
    projectId: project.id, agentId: 'codex', prompt: 'Use remote base', checkoutMode: 'worktree', startBase: 'origin/main'
  })
  await tick()
  expect(resolveBase).toHaveBeenCalledWith(project.path, 'origin/main')
  expect(prepare).toHaveBeenCalledWith(project.path, based.id, expect.any(Function), {
    commit: 'base-origin/main', branch: 'origin/main'
  })
  expect(store.getTask(based.id)).toMatchObject({ checkoutMode: 'worktree', startBase: 'origin/main', baseBranch: 'origin/main' })
})

test('rejects malformed IPC requests before accessing dependencies or files', async () => {
  const { store, delivery, agentProcesses, credentials, client, call, project } = setupIpc()
  // Any dependency access means a malformed request escaped the IPC contract.
  const touched: string[] = []
  const restore: (() => void)[] = []
  const watch = (name: string, target: object): void => {
    const record = target as Record<string, unknown>
    const keys = new Set([...Object.getOwnPropertyNames(target), ...Object.getOwnPropertyNames(Object.getPrototypeOf(target))])
    for (const key of keys) {
      if (key === 'constructor' || typeof record[key] !== 'function') continue
      const original = record[key]
      const own = Object.hasOwn(record, key)
      record[key] = () => { touched.push(`${name}.${key}`); throw new Error('Unexpected dependency access') }
      restore.push(() => { if (own) record[key] = original; else delete record[key] })
    }
  }
  const files = (): [string, string][] => readdirSync(testHome, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => { const path = join(entry.parentPath, entry.name); return [path, readFileSync(path).toString('base64')] })
  const beforeFiles = files()
  Object.assign(shell, { openPath: async () => '', openExternal: async () => {} })
  Object.assign(dialog, { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) })
  for (const [name, target] of Object.entries({ store, delivery, agentProcesses, credentials, client, shell, dialog })) watch(name, target)
  const warnings: unknown[][] = []
  const warn = console.warn
  console.warn = (...args) => { warnings.push(args) }
  const invalidRequest = async (channel: string, payload: unknown): Promise<void> => {
    await expect(async () => call(channel, payload), channel).rejects.toThrow(/Invalid IPC request/)
  }
  const update = { id: project.id, monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false }
  const comment = { taskId: 'task', file: 'src/file.ts', side: 'additions', lineNumber: 1, body: 'Review' }
  const validPreview = { sourceBranch: 'task', targetBranch: 'main', sourceCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40), commitCount: 1 }
  try {
    for (const channel of handlers.keys()) {
      for (const payload of [null, [], 42, true]) await invalidRequest(channel, payload)
      const extra = () => handlers.get(channel)!(rendererEvent, undefined, 'extra')
      await expect(async () => extra()).rejects.toThrow(/Invalid IPC request/)
    }
    for (const key of ['path', 'name', 'createdAt', 'gitPlatform', '__proto__']) {
      await invalidRequest('projects:update', { ...update, [key]: '/outside' })
    }
    for (const value of [NaN, Infinity, -Infinity, -1, '2']) {
      await invalidRequest('projects:update', { ...update, monthlyTokenLimit: value })
      await invalidRequest('projects:update', { ...update, monthlyCostLimitUsd: value })
    }
    await invalidRequest('projects:update', { ...update, monthlyTokenLimit: 1.5 })
    await invalidRequest('projects:update', { ...update, finishOnPush: 1 })
    for (const payload of [
      {}, { projectId: '../project' }, { projectId: '/outside' }, { projectId: '' },
      { projectId: project.id, path: '/outside' }, { projectId: project.id, query: '../outside' },
      { projectId: project.id, limit: 1_000_000 }
    ]) await invalidRequest('projects:files', payload)
    for (const channel of ['projects:remove', 'projects:reveal', 'projects:git-init', 'tasks:delete', 'tasks:cancel', 'tasks:issues', 'tasks:approve-issue', 'comments:send']) {
      for (const id of ['', ' ', '../project', 'x'.repeat(129)]) await invalidRequest(channel, id)
    }
    for (const patch of [{ taskId: 'task', issueId: '' }, { taskId: 'task', issueId: 42 }, { taskId: 'task', issueId: 'ok', extra: 1 }]) {
      await invalidRequest('tasks:issue-diff', patch)
    }
    for (const patch of [{ taskId: '' }, { taskId: 'task', comment: ' ' }, { taskId: 'task', comment: 42 }]) {
      await invalidRequest('tasks:reject-issue', patch)
    }
    for (const patch of [{ side: 'left' }, { lineNumber: 0 }, { lineNumber: NaN }, { lineNumber: 1.5 }, { file: '/etc/passwd' }, { file: '../outside' }, { file: 'a/../b' }, { file: 'C:\\outside' }, { file: '' }, { body: ' ' }, { body: 'x'.repeat(20_001) }]) {
      await invalidRequest('comments:add', { ...comment, ...patch })
    }
    for (const patch of [{ defaultAgentId: null }, { rebaseMode: 'shell' }, { confirmRebase: 1 }, { keybindings: [] }, { keybindings: { toggleSidebar: 'x' } }, { unexpected: true }]) await invalidRequest('settings:set', patch)
    for (const patch of [{ prompt: ' ' }, { prompt: 'x'.repeat(100_001) }, { style: 'chat' }, { reviewPolicy: 'always' }, { model: [] }, { reasoningEffort: 42 }]) await invalidRequest('tasks:start', { projectId: project.id, agentId: 'codex', prompt: 'Task', ...patch })
    await invalidRequest('tasks:issues', { taskId: 'task', projectPath: '/outside', parentIssueId: 'other' })
    await invalidRequest('tasks:steer', { taskId: 'task', message: ' ' })
    for (const steps of [null, [], [null], [{ sha: 'a'.repeat(40), action: 'exec', message: 'rm' }], [{ sha: '--exec', action: 'pick', message: 'message' }]]) await invalidRequest('tasks:rebase', { taskId: 'task', steps })
    for (const patch of [{ commitCount: NaN }, { commitCount: -1 }, { sourceCommit: '--exec' }, { targetBranch: '-f' }]) await invalidRequest('tasks:approve', { taskId: 'task', preview: { ...validPreview, ...patch } })
    await invalidRequest('github:open-pr', { taskId: 'task', preview: null, title: 'Title', description: '' })
    await invalidRequest('github:draft-pr-field', { taskId: 'task', field: 'command', title: '', description: '' })
    await invalidRequest('github:set-token', 'x'.repeat(1025))
    expect(touched, 'Invalid requests cannot reach store, terminal, Git, credentials, filesystem openers or agents').toStrictEqual([])
    expect(files(), 'Invalid requests leave filesystem contents unchanged').toStrictEqual(beforeFiles)
  } finally {
    console.warn = warn
    for (const reset of restore) reset()
  }
})

test('updates projects, validates task references and selects supported agents and settings', async () => {
  const { store, project, call, memory } = setupIpc()
  const update = { id: project.id, monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false }
  const comment = { taskId: 'task', file: 'src/file.ts', side: 'additions', lineNumber: 1, body: 'Review' }
  const projectSettings = { ...update, monthlyTokenLimit: 5000, monthlyCostLimitUsd: 12.5, finishOnPush: true }
  expect(call('projects:update', projectSettings)).toStrictEqual({ ...project, ...projectSettings })
  expect(call('projects:update', { id: project.id, monthlyTokenLimit: null })).toStrictEqual({ ...project, ...projectSettings, monthlyTokenLimit: null })
  expect(call('projects:update', { id: project.id, finishOnPush: false })).toStrictEqual({ ...project, ...projectSettings, monthlyTokenLimit: null, finishOnPush: false })
  // Defense in depth: even a non-IPC caller cannot smuggle extra database columns.
  store.updateProject(project.id, { ...update, id: 'replacement', path: '/outside', name: 'Changed', createdAt: 99 } as typeof update)
  expect(store.getProjects()).toStrictEqual([project])
  const opened: string[] = []
  Object.assign(shell, { openPath: async (path: string) => { opened.push(path); return '' } })
  expect(await call('projects:reveal', project.id)).toBe(project.path)
  expect(opened).toEqual([])
  expect(() => call('projects:reveal', 'missing')).toThrow(/Project not found/)
  expect(() => call('comments:add', { ...comment, taskId: 'missing' })).toThrow(/Task not found/)

  expect(titleFor('  First line\nSecond line')).toBe('First line')
  expect(titleFor(' \n ')).toBe('Untitled task')
  expect(titleFor('a'.repeat(72))).toBe('a'.repeat(72))
  expect(titleFor('a'.repeat(73))).toBe(`${'a'.repeat(71)}...`)
  expect(await memory.promptWithProjectMemory(project.id, 'Task')).toBe('Task')
  expect(call('projects:list')).toStrictEqual([project])
  expect(call('agents:list').map((agent: { id: string }) => agent.id)).toStrictEqual(['opencode', 'codex'])
  expect(() => call('agents:models', { agentId: 'missing' })).toThrow(/Unknown agent/)
  expect(() => call('agents:models', { agentId: 'pi' })).toThrow(/Unknown agent/)
  await expect(call('tasks:start', { projectId: project.id, agentId: 'pi', prompt: 'Unsupported agent' })).rejects.toThrow(/Unknown agent/)
  store.setSettings({ defaultAgentId: 'pi', defaultModel: 'old-model' })
  const fallbackSettings = call('settings:get')
  expect(fallbackSettings.defaultAgentId).toBe('opencode')
  expect(fallbackSettings.defaultModel).toBe(call('agents:list')[0].defaultModel)
  expect(call('settings:set', { confirmRebase: false }).defaultAgentId).toBe('opencode')
  const codexSettings = call('settings:set', { defaultAgentId: 'codex', defaultModel: 'selected-model' })
  expect(codexSettings.defaultAgentId).toBe('codex')
  expect(codexSettings.defaultModel).toBe('selected-model')
})

test('runs local Quick tasks directly without issue plans', async () => {
  const { store, project, agentProcesses, delivery, call, tick } = setupIpc()
  const prepareBranch = vi.spyOn(delivery, 'prepareBranch')

  const quick: Task = await call('tasks:start', {
    style: 'quick', projectId: project.id, agentId: 'codex', prompt: 'Explain the current architecture or make a focused change'
  })
  await tick()
  expect(quick.style).toBe('quick')
  expect(store.getTask(quick.id)).toMatchObject({ checkoutMode: 'local', cwd: project.path, deliveryStatus: 'unavailable' })
  expect(call('tasks:issues', quick.id)).toBeNull()
  expect(agentProcesses.starts.at(-1)).toMatchObject({
    taskId: quick.id, cwd: project.path, issueTracker: false
  })
  expect(agentProcesses.starts.at(-1)).not.toHaveProperty('readOnly')
  expect(agentProcesses.starts.at(-1).prompt).toContain('Answer or complete the request directly')
  expect(prepareBranch).not.toHaveBeenCalled()
  agentProcesses.emit('session', { taskId: quick.id, sessionId: 'quick-session' })
  agentProcesses.finishTurn(quick.id, 'Architecture answer')
  await tick()
  expect(store.getTask(quick.id)?.status).toBe('succeeded')
  expect(store.getTaskExecution(quick.id)?.phase).toBe('complete')

  await call('tasks:steer', { taskId: quick.id, message: 'Make the focused change' })
  expect(agentProcesses.starts.at(-1)).toMatchObject({
    taskId: quick.id, cwd: project.path, issueTracker: false, resumeSessionId: 'quick-session'
  })
  expect(store.getTask(quick.id)?.branchName).toBeUndefined()
  const parallelQuick: Task = await call('tasks:start', {
    style: 'quick', checkoutMode: 'local', projectId: project.id, agentId: 'codex', prompt: 'Run another quick task'
  })
  await tick()
  expect(store.getTask(parallelQuick.id)).toMatchObject({ cwd: project.path, checkoutMode: 'local', status: 'running' })
  await expect(call('projects:checkout', { projectId: project.id, branchName: 'main' })).rejects.toThrow('active task using this project checkout')
  await expect(call('tasks:start', {
    style: 'quick', parentTaskId: quick.id, projectId: project.id, agentId: 'codex', prompt: 'Stack this'
  })).rejects.toThrow('Only Work tasks can be stacked')
  agentProcesses.finishTurn(quick.id, 'Focused change complete')
  await tick()
  expect(store.getTask(quick.id)?.status).toBe('succeeded')
  expect(prepareBranch).not.toHaveBeenCalled()
  call('tasks:settle', quick.id)
  expect(store.getTask(quick.id)?.settledAt).toBeTypeOf('number')
})

test('runs Quick tasks in managed worktrees when selected', async () => {
  const { store, project, agentProcesses, delivery, call, tick } = setupIpc()
  const prepareBranch = vi.spyOn(delivery, 'prepareBranch')
  const finalizeBranch = vi.spyOn(delivery, 'finalizeBranch')

  const quick: Task = await call('tasks:start', {
    style: 'quick', checkoutMode: 'worktree', startBase: 'origin/main', projectId: project.id,
    agentId: 'codex', prompt: 'Make a focused isolated change'
  })
  await tick()

  expect(prepareBranch).toHaveBeenCalledWith(project.path, quick.id, expect.any(Function), {
    commit: 'base-origin/main', branch: 'origin/main'
  })
  expect(store.getTask(quick.id)).toMatchObject({
    checkoutMode: 'worktree', startBase: 'origin/main', branchName: 'task', baseBranch: 'origin/main',
    deliveryStatus: 'working'
  })
  expect(agentProcesses.starts.at(-1)).toMatchObject({ taskId: quick.id, issueTracker: false })
  expect(agentProcesses.starts.at(-1).prompt).toContain('Answer or complete the request directly')

  agentProcesses.finishTurn(quick.id, 'Focused isolated change complete')
  await tick()
  expect(finalizeBranch).toHaveBeenCalled()
  expect(store.getTask(quick.id)).toMatchObject({ status: 'succeeded', deliveryStatus: 'reviewable' })
})

test('executes issues, reviews, handles credentials and PRs, approves, rebases and guards deletion', async () => {
  const comment = { taskId: 'task', file: 'src/file.ts', side: 'additions', lineNumber: 1, body: 'Review' }
  const fixture = setupIpc()
  const { taskEvents, store, tasks, trackers, events, notifications, project, agentProcesses, gitDelivery, rebaseCalls, mergeCalls, mergeConflictCalls, pushCalls, mergeState, call, tick } = fixture
  const task: Task = await call('tasks:start', { projectId: project.id, agentId: 'codex', model: 'chosen-model', reasoningEffort: 'high', prompt: 'Task title\nDetails' })
  await tick()
  expect(task.title).toBe('Task title')
  expect(agentProcesses.starts.length).toBe(1)
  await expect(call('tasks:approve', { taskId: task.id, preview: await gitDelivery.getMergePreview(testHome, 'task') })).rejects.toThrow(/not finished/)
  await expect(call('tasks:merge-preview', task.id)).rejects.toThrow(/not finished/)
  await expect(call('github:pr-preview', task.id)).rejects.toThrow(/not finished/)
  expect(() => call('github:open-pr-url', 'file:///etc/passwd')).toThrow(/Invalid GitHub PR URL/)
  await expect(call('tasks:rebase-agent', task.id)).rejects.toThrow(/not finished/)
  const issue = { key: 'first', title: 'Change', description: 'One change', labels: [], priority: 'medium' as const, dependencies: [], checklist: ['Test'], validation: 'Run test' }
  agentProcesses.plan(task.id, [issue, { ...issue, key: 'second', dependencies: ['first'] }])
  await tick()
  expect(agentProcesses.starts.length).toBe(2)
  expect(agentProcesses.starts[1].reasoningEffort, 'Implementation inherits the original task effort').toBe('high')
  expect(store.getTaskExecution(task.id)?.reasoningEffort).toBe('high')
  let tracker = trackers.get(task.id)!
  agentProcesses.emit('session', { taskId: task.id, sessionId: 'session' })
  agentProcesses.emit('usage', { taskId: task.id, inputTokens: 5, outputTokens: 2, cachedTokens: 0, totalTokens: 7, costUsd: 0.1 })
  agentProcesses.emit('usage', { taskId: task.id, inputTokens: 6, outputTokens: 2, cachedTokens: 0, totalTokens: 8, costUsd: 0.2 })
  agentProcesses.completeIssue(task.id, tracker.items[0].id, { checklist: [true], evidence: 'Test passed' })
  await tick()
  expect(agentProcesses.starts.length).toBe(3)
  expect(tasks.get(task.id)?.status).toBe('running')
  expect(tasks.get(task.id)?.totalTokens, 'Usage events are snapshots within one process').toBe(8)
  tracker = trackers.get(task.id)!
  agentProcesses.emit('usage', { taskId: task.id, inputTokens: 2, outputTokens: 1, cachedTokens: 0, totalTokens: 3, costUsd: null })
  agentProcesses.completeIssue(task.id, tracker.items[1].id, { checklist: [true], evidence: 'Test passed' })
  await tick()
  expect(tasks.get(task.id)?.deliveryStatus).toBe('reviewable')
  expect(tasks.get(task.id)?.totalTokens, 'Usage accumulates across sequential processes').toBe(11)
  expect(tasks.get(task.id)?.costUsd).toBe(0.2)
  expect(tasks.get(task.id)?.headCommit).toMatch(/^[0-9a-f]{40}$/)
  expect((await call('tasks:diff', task.id)).patch).toBe(`base..${tasks.get(task.id)?.headCommit}`)

  expect(() => call('comments:add', { taskId: task.id, body: ' ' })).toThrow(/Invalid IPC request/)
  const draft: TaskComment[] = call('comments:add', { taskId: task.id, file: 'file.ts', side: 'additions', lineNumber: 9, body: ' Fix this ' })
  expect(draft[0].body).toBe('Fix this')
  const otherTask = { ...task, id: 'other-task' }
  store.addTask(otherTask)
  expect(() => call('comments:remove', { taskId: otherTask.id, id: draft[0].id })).toThrow(/does not belong/)
  expect(store.getComments(task.id)).toStrictEqual(draft)
  const otherDraft = call('comments:add', { ...comment, taskId: otherTask.id })
  expect(call('comments:remove', { taskId: otherTask.id, id: otherDraft[0].id })).toStrictEqual([])
  expect(store.getComments(task.id)).toStrictEqual(draft)
  store.deleteTaskCascade(otherTask.id)
  const followup = await call('comments:send', task.id)
  await tick()
  expect(followup.task.status).toBe('running')
  expect(followup.comments[0].sentAt).toBeTruthy()
  expect(agentProcesses.starts.at(-1).resumeSessionId).toBe('session')
  expect(agentProcesses.starts.at(-1).reasoningEffort).toBe('high')
  agentProcesses.finishTurn(task.id)
  await tick()
  expect(tasks.get(task.id)?.deliveryStatus, 'Review follow-ups finalize without replanning').toBe('reviewable')
  await expect(call('comments:send', task.id)).rejects.toThrow(/no comments/)
  expect(await call('github:credential-status')).toStrictEqual({ configured: false })
  expect(await call('github:set-token', 'test-token')).toStrictEqual({ configured: true })
  expect('githubToken' in store.getSettings(), 'Tokens stay out of ordinary settings').toBe(false)
  const prPreview = await call('github:pr-preview', task.id)
  expect(prPreview.account).toBe('developer')
  const taskUpdatesBeforePullRequest = notifications.filter((notification) => notification.channel === 'task:updated').length
  const pullRequest = await call('github:open-pr', { taskId: task.id, preview: prPreview, title: 'User PR title', description: 'User PR description' })
  expect(fixture.prRefreshes, 'Opening a PR schedules a status refresh').toBe(1)
  expect(store.getPullRequestsToRefresh().some((link) => link.taskId === task.id && link.number === 7), 'Persist the task association before refreshing').toBeTruthy()
  expect(pullRequest.number).toBe(7)
  expect(pullRequest.title).toBe('User PR title')
  expect(pullRequest.description).toBe('User PR description')
  expect(pushCalls.map((args) => args.slice(0, 2))).toStrictEqual([[testHome, prPreview]])
  expect(tasks.get(task.id)?.deliveryStatus, 'Opening a PR does not approve locally').toBe('reviewable')
  const pullRequestUpdates = notifications.filter((notification) => notification.channel === 'task:updated').slice(taskUpdatesBeforePullRequest)
  expect(pullRequestUpdates).toHaveLength(1)
  expect(pullRequestUpdates[0].payload).toMatchObject({
    id: task.id,
    pullRequest: { number: 7, url: 'https://github.com/developer/project/pull/7' }
  })
  expect(events.some((event) => event.text.includes(pullRequest.url))).toBeTruthy()
  const beforeCredentialRemoval = fixture.credentialRefreshes
  expect(await call('github:remove-token')).toStrictEqual({ configured: false })
  expect(fixture.credentialRefreshes, 'Removing credentials invalidates polling responses').toBe(beforeCredentialRemoval + 1)

  const preview = await call('tasks:merge-preview', task.id)
  expect(preview.sourceBranch).toBe('task')
  expect(preview.targetBranch).toBe('main')
  expect(preview.commitCount).toBe(1)
  mergeState.conflict = true
  const conflicted: Task = await call('tasks:approve', { taskId: task.id, preview })
  expect(conflicted.deliveryStatus).toBe('merge_conflict')
  expect(conflicted.mergeConflict).toMatchObject({
    taskId: task.id,
    workspaceId: task.workspaceId,
    projectId: task.projectId,
    repositoryRoot: testHome,
    sourceBranch: 'task',
    targetBranch: 'main',
    sourceCommit: preview.sourceCommit,
    targetCommit: preview.targetCommit,
    mergeHeadCommit: preview.sourceCommit,
    conflictedFiles: ['src/conflicted.ts'],
    requestedAction: 'merge'
  })
  expect(tasks.get(task.id)?.reviewedAt).toBe(undefined)
  expect(events.at(-1)?.text).toBe('Merge paused: 1 file conflict with main.')
  const conflictId = conflicted.mergeConflict!.id
  const snapshot = await call('tasks:merge-conflict', { taskId: task.id, conflictId })
  expect(snapshot).toMatchObject({ id: conflictId, taskId: task.id, targetBranch: 'main', canComplete: false })
  expect(snapshot.files[0]).toMatchObject({ path: 'src/conflicted.ts', status: 'both_modified', support: 'text' })
  expect(() => call('tasks:merge-conflict-fix-agent', { taskId: task.id, conflictId, extra: true })).toThrow(/Invalid IPC request/)
  const executionBeforeRepair = store.getTaskExecution(task.id)
  const failedRepair = call('tasks:merge-conflict-fix-agent', { taskId: task.id, conflictId })
  await tick()
  expect(agentProcesses.starts.at(-1)).toMatchObject({
    taskId: task.id,
    cwd: project.path,
    projectPath: project.path,
    model: 'chosen-model',
    reasoningEffort: 'high',
    resumeSessionId: 'session',
    issueTracker: false,
    prompt: mergeConflictRepairPrompt(conflicted.mergeConflict!, ['src/conflicted.ts'])
  })
  expect(agentProcesses.starts.at(-1)).not.toHaveProperty('issueId')
  await expect(call('tasks:merge-conflict-save', {
    taskId: task.id, conflictId, path: 'src/conflicted.ts', contents: 'resolved', expectedContentsHash: '1'.repeat(64)
  })).rejects.toThrow(/busy with merge-repair/)
  agentProcesses.finishTurn(task.id, 'Repair incomplete', 1)
  expect(await failedRepair).toMatchObject({ deliveryStatus: 'merge_conflict' })
  expect(store.getTaskExecution(task.id)).toStrictEqual(executionBeforeRepair)
  expect(events.at(-1)?.text).toContain('remains paused')

  const cancelledRepair = call('tasks:merge-conflict-fix-agent', { taskId: task.id, conflictId })
  await tick()
  expect(await call('tasks:cancel', task.id)).toBe(true)
  expect(await cancelledRepair).toMatchObject({ deliveryStatus: 'merge_conflict' })
  expect(tasks.get(task.id)?.status).toBe('succeeded')
  expect(events.at(-1)?.text).toContain('was cancelled')

  vi.spyOn(agentProcesses, 'startResumed').mockRejectedValueOnce(new Error('Repair dispatch failed'))
  await expect(call('tasks:merge-conflict-fix-agent', { taskId: task.id, conflictId })).rejects.toThrow('Repair dispatch failed')
  expect(tasks.get(task.id)?.deliveryStatus).toBe('merge_conflict')
  expect(events.at(-1)?.text).toContain('Could not start agent merge repair')
  expect(() => call('tasks:merge-conflict-save', {
    taskId: task.id, conflictId, path: '../outside.ts', contents: 'resolved', expectedContentsHash: '1'.repeat(64)
  })).toThrow(/Invalid IPC request/)
  expect(() => call('tasks:merge-conflict-save', {
    taskId: task.id, conflictId, path: 'src/conflicted.ts', contents: 'x'.repeat(MERGE_CONFLICT_MAX_FILE_BYTES + 1), expectedContentsHash: '1'.repeat(64)
  })).toThrow(/Invalid IPC request/)
  expect(() => call('tasks:merge-conflict-save', {
    taskId: task.id, conflictId, path: 'src/conflicted.ts', contents: 'resolved', expectedContentsHash: '1'.repeat(40)
  })).toThrow(/Invalid IPC request/)
  await expect(call('tasks:merge-conflict-complete', { taskId: task.id, conflictId })).rejects.toThrow(/Resolve all merge conflicts/)
  const stillConflicted = await call('tasks:merge-conflict-save', {
    taskId: task.id, conflictId, path: 'src/conflicted.ts', contents: '<<<<<<< HEAD\nnew target\n=======\nsource\n>>>>>>> task\n', expectedContentsHash: '1'.repeat(64)
  })
  expect(stillConflicted).toMatchObject({ canComplete: false, files: [{ contentsHash: '2'.repeat(64) }] })
  await expect(call('tasks:delete', task.id)).rejects.toThrow(/Abort the paused merge/)
  await expect(call('projects:remove', project.id)).rejects.toThrow(/Abort the paused task merge/)
  await expect(call('projects:checkout', { projectId: project.id, branchName: 'other' })).rejects.toThrow(/paused task merge/)
  expect(() => call('tasks:settle', task.id)).toThrow(/successful, reviewed/)
  const competitor = store.addTask({
    ...tasks.get(task.id)!, id: 'competing-task', branchName: 'competing-task',
    deliveryStatus: 'reviewable', mergeConflict: undefined
  })
  const competitorExecution = new TaskIssues(store).initialize(competitor.id, project.path)
  store.saveTaskExecution({ ...competitorExecution, phase: 'complete' })
  await expect(call('tasks:merge-preview', competitor.id)).rejects.toThrow(/Another task owns a paused merge/)
  mergeState.validationFailure = true
  await expect(call('tasks:merge-preview', competitor.id)).rejects.toThrow(/no longer matches/)
  mergeState.validationFailure = false
  store.deleteTaskCascade(competitor.id)
  const aborted: Task = await call('tasks:merge-conflict-abort', { taskId: task.id, conflictId })
  expect(aborted).toMatchObject({ deliveryStatus: 'reviewable', reviewedAt: undefined })
  expect(aborted.mergeConflict).toBeUndefined()
  expect(events.at(-1)?.text).toMatch(/Aborted the paused merge into main/)
  await expect(call('tasks:merge-conflict', { taskId: task.id, conflictId })).rejects.toThrow(/session changed/)
  const mergeAndPushPreview = await call('tasks:merge-and-push-preview', task.id)
  const pushConflict: Task = await call('tasks:merge-and-push', { taskId: task.id, preview: mergeAndPushPreview })
  expect(pushConflict.mergeConflict).toMatchObject({
    requestedAction: 'merge_and_push',
    pushPreview: {
      targetBranch: 'main',
      targetCommit: preview.targetCommit,
      remote: 'origin',
      remoteTargetCommit: 'c'.repeat(40),
      remoteUrlHash: 'f'.repeat(64)
    }
  })
  const pushConflictId = pushConflict.mergeConflict!.id
  await expect(call('tasks:merge-conflict-save', {
    taskId: task.id, conflictId: 'stale-session', path: 'src/conflicted.ts', contents: 'resolved\n', expectedContentsHash: '2'.repeat(64)
  })).rejects.toThrow(/session changed/)
  const resolved = await call('tasks:merge-conflict-save', {
    taskId: task.id, conflictId: pushConflictId, path: 'src/conflicted.ts', contents: 'resolved\n', expectedContentsHash: '2'.repeat(64)
  })
  expect(resolved).toMatchObject({ canComplete: true, files: [] })
  const manuallyApproved: Task = await call('tasks:merge-conflict-complete', { taskId: task.id, conflictId: pushConflictId })
  expect(manuallyApproved).toMatchObject({ deliveryStatus: 'approved', mergeConflict: undefined })
  expect(pushCalls.at(-1)?.slice(0, 3)).toStrictEqual([
    testHome,
    expect.objectContaining({ targetBranch: 'main', targetCommit: 'e'.repeat(40), remoteTargetCommit: 'c'.repeat(40) }),
    preview.sourceCommit
  ])
  expect(events.some((event) => event.text.includes(`Completed the paused merge of task into main at ${'e'.repeat(40)}`))).toBeTruthy()
  expect(mergeConflictCalls.map((call) => call.operation)).toStrictEqual([
    'load', 'load', 'load', 'load', 'complete', 'save', 'abort', 'save', 'complete'
  ])
  store.updateTask(task.id, { deliveryStatus: 'reviewable', mergeConflict: undefined })
  mergeState.files = [{
    path: 'src/conflicted.ts', status: 'both_modified', stages: [1, 2, 3], support: 'text',
    contents: '<<<<<<< HEAD\ntarget\n=======\nsource\n>>>>>>> task\n', contentsHash: '3'.repeat(64)
  }]
  const agentConflict: Task = await call('tasks:approve', { taskId: task.id, preview })
  const agentRepair = call('tasks:merge-conflict-fix-agent', { taskId: task.id, conflictId: agentConflict.mergeConflict!.id })
  await tick()
  mergeState.files = []
  agentProcesses.finishTurn(task.id, 'Merge repaired')
  const agentApproved: Task = await agentRepair
  expect(agentApproved).toMatchObject({ deliveryStatus: 'approved', mergeConflict: undefined })
  expect(store.getTaskExecution(task.id)).toStrictEqual(executionBeforeRepair)
  expect(events.some((event) => event.text.includes('Agent completed the paused merge of task into main'))).toBeTruthy()
  store.updateTask(task.id, { deliveryStatus: 'reviewable', mergeConflict: undefined, reviewedAt: undefined })
  mergeState.conflict = false
  const pendingApproval = call('tasks:approve', { taskId: task.id, preview })
  expect(tasks.get(task.id)?.deliveryStatus, 'Approval waits for Git to finish').toBe('reviewable')
  await expect(call('tasks:approve', { taskId: task.id, preview })).rejects.toThrow(/already busy/)
  await expect(call('tasks:delete', task.id)).rejects.toThrow(/merge attempt to finish/)
  await expect(call('projects:remove', project.id)).rejects.toThrow(/merge attempt to finish/)
  mergeState.finish!()
  const approved: Task = await pendingApproval
  expect(mergeCalls.map((args) => args.slice(0, 3))).toStrictEqual([
    [testHome, 'task', preview],
    [testHome, 'task', mergeAndPushPreview],
    [testHome, 'task', preview],
    [testHome, 'task', preview]
  ])
  expect(approved.deliveryStatus).toBe('approved')
  expect(approved.reviewedAt).toBeTruthy()
  await expect(call('tasks:merge-preview', task.id)).rejects.toThrow(/not awaiting review/)

  await call('tasks:rebase-agent', task.id)
  await tick()
  expect(agentProcesses.starts.at(-1).resumeSessionId).toBe('session')
  expect(agentProcesses.starts.at(-1).prompt).toBe(agentRebasePrompt('base'))
  agentProcesses.finishTurn(task.id)
  await tick()
  const startsBeforeRebase = agentProcesses.starts.length
  const steps: RebaseStep[] = [{ sha: 'c'.repeat(40), action: 'drop', message: '' }]
  const rebased: Task = await call('tasks:rebase', { taskId: task.id, steps })
  expect(rebased.deliveryStatus).toBe('no_changes')
  expect(rebased.headCommit).toBe('rebased')
  expect(agentProcesses.starts.length).toBe(startsBeforeRebase)
  expect(rebaseCalls.map((args) => args.slice(0, 5))).toStrictEqual([[testHome, task.id, 'task', 'base', steps]])
  expect(events.some((event) => /dropping 1/.test(event.text))).toBeTruthy()

  const pendingRebase = call('tasks:rebase-agent', task.id)
  call('tasks:delete', task.id)
  await expect(pendingRebase).rejects.toThrow(/Task was deleted/)
  await tick()
  expect(agentProcesses.starts.length, 'Deletion during reopen prevents a late agent start').toBe(startsBeforeRebase)
  const eventCount = events.length
  agentProcesses.emit('event', { id: randomUUID(), taskId: task.id, text: 'late output' })
  agentProcesses.emit('usage', { taskId: task.id, totalTokens: 100 })
  agentProcesses.emit('session', { taskId: task.id, sessionId: 'late' })
  taskEvents.recordSystemEvent(task.id, 'late system event')
  expect(events.length).toBe(eventCount)
  expect(tasks.has(task.id)).toBe(false)
  expect(notifications.some((notification) => notification.channel === 'task:event')).toBeTruthy()
  expect(notifications.some((notification) => notification.channel === 'task:updated')).toBeTruthy()
})

test('blocks failed planning, cancels preparation and between issues, and forwards native effort', async () => {
  const { store, tasks, trackers, project, agentProcesses, call, tick } = setupIpc()
  const issue = { key: 'first', title: 'Change', description: 'One change', labels: [], priority: 'medium' as const, dependencies: [], checklist: ['Test'], validation: 'Run test' }
  const invalid: Task = await call('tasks:start', { projectId: project.id, agentId: 'codex', prompt: 'Invalid plan' })
  await tick()
  agentProcesses.finishTurn(invalid.id, 'Planning failed.', 1)
  await tick()
  expect(tasks.get(invalid.id)?.status).toBe('pending')
  expect(trackers.get(invalid.id)?.phase).toBe('blocked')

  const cancelled: Task = await call('tasks:start', { projectId: project.id, agentId: 'codex', prompt: 'Cancel between issues' })
  await tick()
  agentProcesses.plan(cancelled.id, [issue, { ...issue, key: 'second', dependencies: ['first'] }])
  await tick()
  const currentIssue = trackers.get(cancelled.id)!.items[0]
  const startsBeforeCancel = agentProcesses.starts.length
  agentProcesses.completeIssue(cancelled.id, currentIssue.id, { checklist: [true], evidence: 'Test passed' })
  expect(call('tasks:cancel', cancelled.id)).toBe(true)
  await tick()
  expect(agentProcesses.starts.length).toBe(startsBeforeCancel)
  expect(tasks.get(cancelled.id)?.status).toBe('cancelled')
  expect(trackers.get(cancelled.id)?.phase).toBe('blocked')
  const pendingStart = call('tasks:start', { projectId: project.id, agentId: 'codex', prompt: 'Cancel preparation' })
  const preparing = store.getTasks().find((entry) => entry.title === 'Cancel preparation')!
  expect(call('tasks:cancel', preparing.id)).toBe(true)
  await pendingStart
  await tick()
  expect(store.getTask(preparing.id)?.status).toBe('cancelled')
  expect(store.getTask(preparing.id)?.branchName, 'Cancelled preparation must not create a branch').toBe(undefined)
  expect(agentProcesses.isRunning(preparing.id)).toBe(false)
  const nativeEffortTask: Task = await call('tasks:start', {
    projectId: project.id, agentId: 'opencode', prompt: 'Use native reasoning effort',
    model: 'openrouter/deepseek/deepseek-v4', reasoningEffort: 'max'
  })
  await tick()
  expect(agentProcesses.starts.at(-1).taskId).toBe(nativeEffortTask.id)
  expect(agentProcesses.starts.at(-1).reasoningEffort).toBe('max')
  call('tasks:cancel', nativeEffortTask.id)
  await tick()
  GitDeliveryManager.repository = false
  const nonGitEffortTask: Task = await call('tasks:start', {
    projectId: project.id, agentId: 'codex', prompt: 'Use reasoning without Git',
    model: 'reasoner', reasoningEffort: 'native-max'
  })
  await tick()
  expect(agentProcesses.starts.at(-1).taskId).toBe(nonGitEffortTask.id)
  expect(agentProcesses.starts.at(-1).reasoningEffort).toBe('native-max')
  call('tasks:cancel', nonGitEffortTask.id)
  await tick()
  GitDeliveryManager.repository = true
})

test('branch selection resolves only registered project paths', async () => {
  const { call, project, delivery } = setupIpc()
  const calls: unknown[][] = []
  const branches = { currentBranch: 'main', branches: [{ name: 'main', checkedOut: true }, { name: 'feature', checkedOut: false }] }
  Object.assign(delivery, {
    branches: async (...args: unknown[]) => { calls.push(args); return branches },
    switchProjectBranch: async (...args: unknown[]) => { calls.push(args); return { ...branches, currentBranch: 'feature' } }
  })
  expect(await call('projects:branches', project.id)).toEqual(branches)
  expect((await call('projects:checkout', { projectId: project.id, branchName: 'feature' })).currentBranch).toBe('feature')
  expect(calls).toEqual([[project.path], [project.path, 'feature']])
  await expect(call('projects:checkout', { projectId: 'missing', branchName: 'main' })).rejects.toThrow('Project not found')
})

test('validates image payloads before task, tracker or worktree creation', async () => {
  const { call, project, store, delivery, agentProcesses } = setupIpc()
  const images = await taskImages()
  const image = images[0]
  const hugeDimensions = new Uint8Array(pngWithDimensions(4001, 4000))
  const addTask = vi.spyOn(store, 'addTask')
  const prepare = vi.spyOn(delivery, 'prepareBranch')
  const saveExecution = vi.spyOn(store, 'saveTaskExecution')
  const originalFiles = readdirSync(testHome, { recursive: true })
  for (const invalid of [
    null, {}, [null], new Array(1), [{ ...image, filename: '../image.png' }],
    [{ ...image, filename: '' }], [{ ...image, extra: true }], [{ ...image, mimeType: 'image/svg+xml' }],
    [{ ...image, bytes: [1, 2] }], [{ ...image, bytes: image.bytes.buffer }],
    [{ ...image, bytes: new Uint8Array() }], [{ ...image, bytes: new Uint8Array([1, 2, 3]) }],
    [{ ...image, mimeType: 'image/jpeg' }], [{ ...image, bytes: image.bytes.slice(0, 45) }],
    [{ ...image, bytes: hugeDimensions }],
    [{ ...image, bytes: new Uint8Array(TASK_IMAGE_LIMITS.perImageBytes + 1) }],
    Array.from({ length: TASK_IMAGE_LIMITS.count + 1 }, () => image),
    Array.from({ length: 3 }, () => ({ ...image, bytes: new Uint8Array(TASK_IMAGE_LIMITS.perImageBytes) }))
  ]) {
    await expect(async () => call('tasks:start', { projectId: project.id, agentId: 'codex', prompt: 'Inspect image', images: invalid })).rejects.toThrow(/Invalid.*image|Invalid.*images/)
  }
  expect(addTask).not.toHaveBeenCalled()
  expect(saveExecution).not.toHaveBeenCalled()
  expect(prepare).not.toHaveBeenCalled()
  expect(agentProcesses.starts).toHaveLength(0)
  expect(readdirSync(testHome, { recursive: true })).toEqual(originalFiles)
})

test('keeps image bytes separate through memory preparation and both startup paths', async () => {
  const { call, project, store, tick, agentProcesses } = setupIpc(async (_projectId, prompt) => `Project memory\n${prompt}`)
  const images = await taskImages()
  const originalRepository = GitDeliveryManager.repository
  try {
    for (const repository of [true, false]) {
      GitDeliveryManager.repository = repository
      const task: Task = await call('tasks:start', { projectId: project.id, agentId: 'codex', prompt: 'Inspect image', images })
      await tick()
      const dispatched = agentProcesses.starts.find((start) => start.taskId === task.id)
      expect(dispatched.images).toEqual(images)
      expect(store.taskImages.read(task.id)).toEqual(images)
      expect(dispatched.images[0].bytes).not.toBe(images[0].bytes)
      expect(task.prompt).toBe('Inspect image')
      expect(task.deliveryStatus).toBe('preparing')
      expect(store.getTask(task.id)?.deliveryStatus).toBe(repository ? 'working' : 'unavailable')
      expect(JSON.stringify(store.getTask(task.id))).not.toContain('bytes')
      expect(JSON.stringify(store.readEvents(task.id))).not.toContain(Buffer.from(images[0].bytes).toString('base64'))
      call('tasks:delete', task.id)
      await tick()
      expect(store.getTask(task.id)).toBeUndefined()
      expect(store.taskImages.read(task.id)).toBeUndefined()
      expect(agentProcesses.isRunning(task.id)).toBe(false)
    }
  } finally {
    GitDeliveryManager.repository = originalRepository
  }
})

test('keeps the original task workspace when selection changes during image validation', async () => {
  const { call, project, store, tick } = setupIpc()
  const original = store.getActiveWorkspace()
  const work = store.createWorkspace('Work')
  const images = await taskImages()
  store.addProject(project, work.id)
  store.selectWorkspace(work.id)
  const starting: Promise<Task> = call('tasks:start', {
    projectId: project.id, agentId: 'codex', prompt: 'Inspect image', images
  })
  store.selectWorkspace(original.id)
  const task = await starting
  await tick()
  expect(task.workspaceId).toBe(work.id)
  expect(store.getTask(task.id)?.workspaceId).toBe(work.id)
  expect(store.getTasks(original.id)).toEqual([])
})

test('starts an image-only task but rejects an entirely empty draft before creating a task', async () => {
  const { call, project, store, tick, agentProcesses } = setupIpc()
  const images = await taskImages()
  const addTask = vi.spyOn(store, 'addTask')
  for (const prompt of ['', '  \n']) {
    for (const attachments of [undefined, []]) {
      await expect(async () => call('tasks:start', { projectId: project.id, agentId: 'codex', prompt, images: attachments })).rejects.toThrow('requires a prompt or an image')
    }
  }
  expect(addTask).not.toHaveBeenCalled()
  const task: Task = await call('tasks:start', { projectId: project.id, agentId: 'codex', prompt: '', images })
  await tick()
  expect(task.prompt).toBe('')
  expect(agentProcesses.starts.find((start) => start.taskId === task.id).images).toEqual(images)
})

test('releases image preparation on cancellation, deletion and memory failures without dispatch', async () => {
  const images = await taskImages()
  for (const action of ['tasks:cancel', 'tasks:delete', 'failure']) {
    let prepared!: () => void
    const entered = new Promise<void>((resolve) => { prepared = resolve })
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const { call, project, store, tick, agentProcesses, delivery, notifications } = setupIpc(async (_projectId, prompt) => {
      prepared()
      await pending
      if (action === 'failure') throw new Error('Memory unavailable')
      return prompt
    })
    onTestCleanup(() => finish())
    const releaseWorktree = vi.spyOn(delivery, 'releaseWorktree')
    const accepted: Task = await call('tasks:start', { projectId: project.id, agentId: 'codex', prompt: 'Inspect image', images })
    expect(accepted.deliveryStatus).toBe('preparing')
    expect(notifications).toContainEqual({ channel: 'task:updated', payload: accepted })
    await entered
    const task = store.getTasks().find((task) => task.prompt === 'Inspect image')!
    expect(task.branchName).toBeTruthy()
    expect(agentProcesses.starts).toHaveLength(0)
    if (action !== 'failure') call(action, task.id)
    finish()
    await tick()
    expect(agentProcesses.starts).toHaveLength(0)
    expect(store.taskImages.read(task.id)).toBeUndefined()
    if (action === 'tasks:delete') {
      expect(store.getTask(task.id)).toBeUndefined()
      expect(releaseWorktree).toHaveBeenCalledWith(project.path, task.id, task.branchName)
    } else {
      expect(store.getTask(task.id)?.branchName).toBe(task.branchName)
      if (action === 'failure') {
        expect(store.getTask(task.id)?.error).toBe('Memory unavailable')
        expect(store.getTask(task.id)?.deliveryStatus).toBe('failed')
      } else {
        expect(store.getTask(task.id)?.status).toBe('cancelled')
      }
      expect(notifications).toContainEqual({ channel: 'task:updated', payload: store.getTask(task.id) })
    }
  }
})

test('retains task image originals across storage restart and removes cancelled or deleted owners', async () => {
  const root = join(testHome, `images-${randomUUID()}`)
  const images = await taskImages()
  const storage = new TaskImageStorage(root)
  storage.save('recoverable', images)
  storage.save('cancelled', images)
  const restarted = new TaskImageStorage(root)
  restarted.prune(new Set(['recoverable']))
  expect(restarted.read('recoverable')).toEqual(images)
  expect(restarted.read('cancelled')).toBeUndefined()
  restarted.remove('recoverable')
  expect(readdirSync(root)).toEqual([])
  expect(() => restarted.save('../escape', images)).toThrow('Invalid task image owner')
})

test('resumes interrupted planning with original images and clears them on cancellation', async () => {
  const { call, project, store, tick, agentProcesses } = setupIpc()
  const images = await taskImages()
  const task: Task = await call('tasks:start', { projectId: project.id, agentId: 'codex', prompt: 'Inspect image', images })
  await tick()
  agentProcesses.finishTurn(task.id, 'Interrupted', 1)
  await tick()
  expect(store.taskImages.read(task.id)).toEqual(images)
  await call('tasks:steer', { taskId: task.id, message: 'Continue with the images' })
  expect(agentProcesses.starts.at(-1).images).toEqual(images)
  call('tasks:cancel', task.id)
  await tick()
  expect(store.taskImages.read(task.id)).toBeUndefined()
  await expect(call('tasks:steer', { taskId: task.id, message: 'Continue' })).rejects.toThrow(/original task images were cleared/)
})


test('reloads original image bytes when the app restarts during planning', async () => {
  const { call, project, store, databaseFile, tick } = setupIpc()
  const images = await taskImages()
  const task: Task = await call('tasks:start', { projectId: project.id, agentId: 'codex', prompt: 'Inspect image', images })
  await tick()
  const reopened = new Store(databaseFile, { migrationsFolder: join(process.cwd(), 'src/server/db/migrations') })
  onTestCleanup(() => reopened.close())
  expect(reopened.getTask(task.id)?.status).toBe('pending')
  expect(reopened.getTaskExecution(task.id)?.hasImages).toBe(true)
  expect(reopened.taskImages.read(task.id)).toEqual(images)
  reopened.removeProject(project.id)
  expect(store.taskImages.read(task.id)).toBeUndefined()
})

test('project file IPC returns paths only with registered identity and fresh results', async () => {
  const { call, store, project } = setupIpc()
  const root = mkdtempSync(join(testHome, 'project-files-'))
  onTestCleanup(() => rmSync(root, { recursive: true, force: true }))
  const selected = { ...project, id: 'selected-files', path: root }
  store.addProject(selected)
  writeFileSync(join(root, 'space name.txt'), 'private contents')
  const result: ProjectFileList = await call('projects:files', { projectId: selected.id })
  expect(result).toEqual({
    projectId: selected.id, paths: ['space name.txt'], source: 'directory',
    truncated: false, warnings: [], error: null
  })
  expect(JSON.stringify(result)).not.toContain('private contents')
  expect(JSON.stringify(result)).not.toContain(root)
  writeFileSync(join(root, 'new.txt'), 'new contents')
  expect((await call('projects:files', { projectId: selected.id })).paths).toEqual(['new.txt', 'space name.txt'])
  rmSync(root, { recursive: true })
  expect((await call('projects:files', { projectId: selected.id })).error.code).toBe('unavailable')
  store.removeProject(selected.id)
  expect(await call('projects:files', { projectId: selected.id })).toEqual({
    projectId: selected.id, paths: [], source: null, truncated: false, warnings: [],
    error: { code: 'project-not-found', message: 'Project not found.' }
  })
})

test('project file IPC discards results when the selected project is removed during lookup', async () => {
  const { call, store, project } = setupIpc()
  const root = mkdtempSync(join(testHome, 'project-files-'))
  onTestCleanup(() => rmSync(root, { recursive: true, force: true }))
  const selected = { ...project, id: 'removed-files', path: root }
  store.addProject(selected)
  writeFileSync(join(root, 'file.txt'), 'contents')
  const pending = call('projects:files', { projectId: selected.id })
  store.removeProject(selected.id)
  expect(await pending).toMatchObject({
    projectId: selected.id, paths: [], error: { code: 'project-not-found' }
  })
})

test('file references keep contents out of prompts and reject disappeared files before creation', async () => {
  const { store, project, call, agentProcesses, gitDelivery, tick } = setupIpc()
  vi.spyOn(gitDelivery, 'prepareBranch').mockResolvedValue({ cwd: join(project.path, 'task-worktree'), baseCommit: 'base', branchName: 'task', baseBranch: 'main' })
  const path = `reference ${randomUUID()} 日本語.txt`
  const filename = join(project.path, path)
  const secret = 'FILE_CONTENT_MUST_NOT_BE_INJECTED_8d271'
  writeFileSync(filename, secret)
  onTestCleanup(() => { rmSync(filename, { force: true }); GitDeliveryManager.repository = true })
  for (const repository of [true, false]) {
    GitDeliveryManager.repository = repository
    const task: Task = await call('tasks:start', {
      projectId: project.id, agentId: 'codex', prompt: `Inspect @${JSON.stringify(path)}`, fileReferences: [path]
    })
    await tick()
    const start = agentProcesses.starts.at(-1)
    expect(start.taskId).toBe(task.id)
    expect(start.prompt).not.toContain(secret)
    expect(task.prompt).not.toContain(secret)
    if (repository) expect(start.cwd).not.toBe(project.path)
    else expect(start.cwd).toBe(project.path)
    call('tasks:cancel', task.id)
    await tick()
  }
  const count = store.getTasks().length
  rmSync(filename)
  await expect(call('tasks:start', {
    projectId: project.id, agentId: 'codex', prompt: 'Missing reference', fileReferences: [path]
  })).rejects.toThrow('Referenced file is missing or unavailable')
  await expect(call('tasks:start', {
    projectId: project.id, agentId: 'codex', prompt: 'Invalid reference', fileReferences: ['../outside.txt']
  })).rejects.toThrow('Invalid project file reference')
  expect(store.getTasks()).toHaveLength(count)
})


test('partial project preferences target the captured workspace after switching', () => {
  const { store, call, project } = setupIpc()
  const original = store.getActiveWorkspace()
  const other = store.createWorkspace('Other')
  store.addProject(project, other.id)
  store.selectWorkspace(other.id)
  expect(call('projects:update', { workspaceId: original.id, id: project.id, monthlyTokenLimit: 123 })).toMatchObject({ monthlyTokenLimit: 123 })
  expect(store.getProjects(original.id)[0]).toMatchObject({ monthlyTokenLimit: 123, monthlyCostLimitUsd: null, finishOnPush: false })
  expect(store.getProjects(other.id)[0]).toMatchObject({ monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false })
})


test('stacked tasks wait in order for final delivery and an active push before preparing their branches', async () => {
  const { store, call, gitDelivery, agentProcesses, tick } = setupIpc()
  const parent = await call('tasks:start', { projectId: 'project', agentId: 'codex', prompt: 'Parent' }) as Task
  await tick()
  const stackBase = vi.fn(async () => ({ commit: 'parent-tip', branch: parent.branchName! }))
  Object.assign(gitDelivery, { stackBase })
  const prepare = vi.spyOn(gitDelivery, 'prepareBranch')
  const child = await call('tasks:start', { projectId: 'project', agentId: 'codex', prompt: 'Child', parentTaskId: parent.id }) as Task
  expect(child.parentTaskId).toBe(parent.id)
  expect(store.getTask(child.id)?.parentTaskId).toBe(parent.id)
  const grandchild = await call('tasks:start', { projectId: 'project', agentId: 'codex', prompt: 'Grandchild', parentTaskId: child.id }) as Task
  await tick()
  expect(child.deliveryStatus).toBe('preparing')
  expect(child.branchName).toBeUndefined()
  expect(prepare).not.toHaveBeenCalled()
  expect(agentProcesses.starts.map((start) => start.taskId)).toEqual([parent.id])

  // Stopping the process, finishing an issue, and finalizing delivery all keep the child queued.
  agentProcesses.active.delete(parent.id)
  store.saveTaskExecution({ ...store.getTaskExecution(parent.id)!, phase: 'reviewing' })
  store.activityChanged()
  await tick()
  expect(prepare).not.toHaveBeenCalled()
  store.saveTaskExecution({ ...store.getTaskExecution(parent.id)!, phase: 'complete' })
  store.updateTask(parent.id, { status: 'succeeded', deliveryStatus: 'finalizing' })
  await tick()
  expect(prepare).not.toHaveBeenCalled()
  store.updateTask(parent.id, { deliveryStatus: 'failed' })
  await tick()
  expect(prepare).not.toHaveBeenCalled()

  await withTaskOperation(store, parent.id, 'pull-request', async () => {
    store.updateTask(parent.id, { deliveryStatus: 'reviewable', headCommit: 'parent-tip' })
    await tick()
    expect(prepare).not.toHaveBeenCalled()
  })
  await tick()
  expect(prepare).toHaveBeenCalledWith(testHome, child.id, expect.any(Function), { commit: 'parent-tip', branch: parent.branchName })
  expect(agentProcesses.starts.map((start) => start.taskId)).toEqual([parent.id, child.id])
  expect(store.getTask(grandchild.id)?.branchName).toBeUndefined()

  agentProcesses.active.delete(child.id)
  store.saveTaskExecution({ ...store.getTaskExecution(child.id)!, phase: 'complete' })
  stackBase.mockResolvedValue({ commit: 'child-tip', branch: store.getTask(child.id)!.branchName! })
  store.updateTask(child.id, { status: 'succeeded', deliveryStatus: 'reviewable', headCommit: 'child-tip' })
  await tick()
  expect(prepare).toHaveBeenCalledWith(testHome, grandchild.id, expect.any(Function), { commit: 'child-tip', branch: store.getTask(child.id)!.branchName })
  expect(agentProcesses.starts.map((start) => start.taskId)).toEqual([parent.id, child.id, grandchild.id])
  const count = store.getTasks().length
  await expect(call('tasks:start', { projectId: 'project', agentId: 'codex', prompt: 'Invalid', parentTaskId: 'missing' })).rejects.toThrow('same project')
  expect(store.getTasks()).toHaveLength(count)
})


test('terminal RPC handlers validate payloads without Electron events', () => {
  const write = vi.fn()
  rendererIpc.on('terminals:write', write)
  const send = handlers.get('terminals:write')!
  send(undefined, { sessionId: 'session', data: '\x03' })
  expect(write).toHaveBeenCalledWith({ sessionId: 'session', data: '\x03' })
  expect(() => send(undefined, { sessionId: 'session', data: 'bad', command: 'sh' })).toThrow('Invalid IPC request')
  expect(write).toHaveBeenCalledTimes(1)
})
