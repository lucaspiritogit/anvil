import { onTestCleanup } from './test-cleanup'
import { WallpaperLibrary } from '../src/main/wallpapers'
import { rendererEvent, rendererIpc, rendererFrame } from './renderer-fixture'
import { test, expect, vi } from 'vitest'
import { pngWithDimensions } from './image-fixtures'
import { openSystemTerminal } from '../src/main/system-terminal'
vi.mock('../src/main/system-terminal', () => ({ openSystemTerminal: vi.fn(async () => {}) }))
import { TaskImageStorage } from '../src/main/task-image-storage'
import { taskImages } from './task-image-fixture'
import { TASK_IMAGE_LIMITS } from '../src/shared/types'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { taskState } from './task-state'
import type { AgentProcessManager as RealAgentProcessManager } from '../src/main/agents/process-manager'
import { agentRebasePrompt, reviewPrompt } from '../src/main/agents/task-prompts'
import type { GitDeliveryManager as RealGitDeliveryManager } from '../src/main/git-delivery'
import { registerAgentHandlers } from '../src/main/ipc/agents'
import { registerGitHubHandlers } from '../src/main/ipc/github'
import { GitHubClient } from '../src/main/github-client'
import { GitHubCredentials } from '../src/main/github-credentials'
import { registerProjectHandlers } from '../src/main/ipc/projects'
import { registerRebaseHandlers } from '../src/main/ipc/rebase'
import { registerReviewHandlers } from '../src/main/ipc/review'
import { registerTaskHandlers } from '../src/main/ipc/tasks'
import { registerSteeringHandlers } from '../src/main/ipc/steering'
import { registerWorkspaceHandlers } from '../src/main/ipc/workspaces'
import { registerSettingsHandlers } from '../src/main/ipc/settings'
import { createTaskMemory } from '../src/main/memory/task-memory'
import { createTaskCompletion } from '../src/main/tasks/completion'
import { registerTaskEvents } from '../src/main/tasks/events'
import { registerTaskExecution } from '../src/main/tasks/task-execution'
import { titleFor } from '../src/main/tasks/task-title'
import { Store } from '../src/main/store'
import type { Project, ProjectFileList, RebaseStep, Task, TaskComment, TaskEvent } from '../src/shared/types'
import { AgentProcessManager, GitDeliveryManager, handlers, testHome, shell, dialog } from './issue-tracker-doubles'

function setupIpc(preparePrompt?: (projectId: string, prompt: string) => Promise<string>) {
  const databaseFile = join(testHome, `ipc-${randomUUID()}`, 'anvil.db')
  const store = new Store(databaseFile, { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') })
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
  const pushCalls: unknown[][] = []
  const mergeState = { failure: false, finish: undefined as (() => void) | undefined }
  onTestCleanup(() => { mergeState.finish?.() })
  const delivery = Object.assign(gitDelivery, {
    async getPullRequestPreview() {
      return { sourceBranch: 'task', targetBranch: 'main', sourceCommit: 'a'.repeat(40), targetCommit: 'b'.repeat(40), remoteTargetCommit: 'c'.repeat(40), repository: 'developer/project', remote: 'origin', commitCount: 2 }
    },
    async pushPullRequestBranch(...args: unknown[]) { pushCalls.push(args) },
    async merge(...args: unknown[]) {
      mergeCalls.push(args)
      if (mergeState.failure) throw new Error('Merge conflict')
      await new Promise<void>((resolve) => { mergeState.finish = resolve })
    },
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
  registerProjectHandlers(rendererIpc, { ...context, stopTask: execution.stopTask, getWindow: () => null })
  const call = (name: string, input?: unknown): any => handlers.get(name)!(rendererEvent, name === 'settings:set' ? { workspaceId: 'default', patch: input } : input)
  const tick = async (): Promise<void> => {
    for (let index = 0; index < 8; index++) await new Promise((resolve) => setImmediate(resolve))
  }

  return {
    databaseFile, taskEvents, store, tasks, trackers, events, notifications, project, agentProcesses,
    gitDelivery, delivery, rebaseCalls, mergeCalls, pushCalls, mergeState, memory,
    credentials, client, call, tick,
    get prRefreshes() { return prRefreshes },
    get credentialRefreshes() { return credentialRefreshes }
  }
}

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

test('registers all channels and rejects foreign, subframe and navigated senders', () => {
  setupIpc()
  expect([...handlers.keys()].sort()).toStrictEqual([
    'agents:list', 'agents:models', 'comments:add', 'comments:list', 'comments:remove', 'comments:send',
    'github:credential-status', 'github:set-token', 'github:remove-token', 'github:pr-preview', 'github:open-pr', 'github:draft-pr-field', 'github:open-pr-url',
    'projects:add', 'projects:branches', 'projects:checkout', 'projects:files', 'projects:git-init', 'projects:git-status', 'projects:list', 'projects:remove', 'projects:reveal', 'projects:open-terminal', 'projects:update',
    'tasks:approve', 'tasks:approve-issue', 'tasks:cancel', 'tasks:compact', 'tasks:delete', 'tasks:diff', 'tasks:events', 'tasks:events-page', 'tasks:issue-diff', 'tasks:issues', 'tasks:list', 'tasks:merge-preview', 'tasks:rebase', 'tasks:rebase-agent', 'tasks:reject-issue', 'tasks:restack', 'tasks:settle', 'tasks:stack', 'tasks:stack-dismiss', 'tasks:start', 'tasks:steer',
    'workspaces:list', 'workspaces:snapshot', 'workspaces:create', 'workspaces:rename', 'workspaces:select', 'workspaces:preferences:get', 'workspaces:preferences:set', 'workspaces:composer:import',
    'wallpapers:directory', 'wallpapers:import', 'wallpapers:list', 'wallpapers:read', 'settings:get', 'settings:set'
  ].sort())
  // Each registered handler must reject foreign windows and same-URL subframes
  // before touching its payload or any service dependency.
  for (const event of [
    { sender: {}, senderFrame: rendererEvent.senderFrame },
    { sender: rendererEvent.sender, senderFrame: { url: rendererFrame.url } },
    { sender: rendererEvent.sender, senderFrame: null }
  ]) {
    for (const [channel, handler] of handlers) {
      expect(() => handler(event), channel).toThrow(/Unauthorized IPC sender/)
    }
  }
  const appUrl = rendererFrame.url
  onTestCleanup(() => { rendererFrame.url = appUrl })
  rendererFrame.url = 'https://example.com/'
  for (const [channel, handler] of handlers) {
    expect(() => handler(rendererEvent), channel).toThrow(/Unauthorized IPC sender/)
  }
  rendererFrame.url = appUrl
  expect(openSystemTerminal).not.toHaveBeenCalled()
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
    for (const channel of ['projects:remove', 'projects:reveal', 'projects:open-terminal', 'projects:git-init', 'tasks:delete', 'tasks:cancel', 'tasks:issues', 'tasks:approve-issue', 'comments:send']) {
      for (const id of ['', ' ', '../project', 'x'.repeat(129)]) await invalidRequest(channel, id)
    }
    for (const patch of [{ taskId: 'task', issueId: '' }, { taskId: 'task', issueId: 42 }, { taskId: 'task', issueId: 'ok', extra: 1 }]) {
      await invalidRequest('tasks:issue-diff', patch)
    }
    for (const patch of [{ taskId: '' }, { taskId: 'task', comment: ' ' }, { taskId: 'task', comment: 42 }]) {
      await invalidRequest('tasks:reject-issue', patch)
    }
    await invalidRequest('projects:open-terminal', { projectId: 'project', cwd: '/outside', command: 'bad' })
    for (const patch of [{ side: 'left' }, { lineNumber: 0 }, { lineNumber: NaN }, { lineNumber: 1.5 }, { file: '/etc/passwd' }, { file: '../outside' }, { file: 'a/../b' }, { file: 'C:\\outside' }, { file: '' }, { body: ' ' }, { body: 'x'.repeat(20_001) }]) {
      await invalidRequest('comments:add', { ...comment, ...patch })
    }
    for (const patch of [{ defaultAgentId: null }, { rebaseMode: 'shell' }, { confirmRebase: 1 }, { keybindings: [] }, { keybindings: { toggleSidebar: 'x' } }, { unexpected: true }]) await invalidRequest('settings:set', patch)
    for (const patch of [{ prompt: ' ' }, { prompt: 'x'.repeat(100_001) }, { model: [] }, { reasoningEffort: 42 }]) await invalidRequest('tasks:start', { projectId: project.id, agentId: 'codex', prompt: 'Task', ...patch })
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
  await call('projects:reveal', project.id)
  expect(opened).toStrictEqual([project.path])
  expect(() => call('projects:reveal', 'missing')).toThrow(/Project not found/)
  expect(() => call('projects:open-terminal', 'missing')).toThrow(/Project not found/)
  expect(() => call('comments:add', { ...comment, taskId: 'missing' })).toThrow(/Task not found/)

  expect(titleFor('  First line\nSecond line')).toBe('First line')
  expect(titleFor(' \n ')).toBe('Untitled task')
  expect(titleFor('a'.repeat(72))).toBe('a'.repeat(72))
  expect(titleFor('a'.repeat(73))).toBe(`${'a'.repeat(71)}...`)
  expect(agentRebasePrompt('base')).toMatch(/git reset --soft base/)
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

test('executes issues, reviews, handles credentials and PRs, approves, rebases and guards deletion', async () => {
  const comment = { taskId: 'task', file: 'src/file.ts', side: 'additions', lineNumber: 1, body: 'Review' }
  const fixture = setupIpc()
  const { taskEvents, store, tasks, trackers, events, notifications, project, agentProcesses, gitDelivery, rebaseCalls, mergeCalls, pushCalls, mergeState, call, tick } = fixture
  const task: Task = await call('tasks:start', { projectId: project.id, agentId: 'codex', model: 'chosen-model', reasoningEffort: 'high', prompt: 'Task title\nDetails' })
  await tick()
  expect(task.title).toBe('Task title')
  expect(agentProcesses.starts.length).toBe(1)
  expect(agentProcesses.starts[0].prompt).toMatch(/Leave the finished plan queued/)
  await expect(call('tasks:approve', { taskId: task.id, preview: await gitDelivery.getMergePreview(testHome, 'task') })).rejects.toThrow(/not finished/)
  await expect(call('tasks:merge-preview', task.id)).rejects.toThrow(/not finished/)
  await expect(call('github:pr-preview', task.id)).rejects.toThrow(/not finished/)
  await expect(call('github:open-pr-url', 'file:///etc/passwd')).rejects.toThrow(/Invalid GitHub PR URL/)
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
  expect((await call('tasks:diff', task.id)).patch).toMatch(/base\.\.commit-/)

  expect(() => call('projects:open-terminal', 'missing')).toThrow(/Project not found/)
  expect(() => call('comments:add', { taskId: task.id, body: ' ' })).toThrow(/Invalid IPC request/)
  const draft: TaskComment[] = call('comments:add', { taskId: task.id, file: 'file.ts', side: 'additions', lineNumber: 9, body: ' Fix this ' })
  expect(draft[0].body).toBe('Fix this')
  expect(reviewPrompt(draft)).toMatch(/file.ts:9 — Fix this/)
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
  expect(agentProcesses.starts.at(-1).prompt).toMatch(/file.ts:9 — Fix this/)
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
  mergeState.failure = true
  await expect(call('tasks:approve', { taskId: task.id, preview })).rejects.toThrow(/Merge conflict/)
  expect(tasks.get(task.id)?.deliveryStatus).toBe('reviewable')
  expect(tasks.get(task.id)?.reviewedAt).toBe(undefined)
  mergeState.failure = false
  const pendingApproval = call('tasks:approve', { taskId: task.id, preview })
  expect(tasks.get(task.id)?.deliveryStatus, 'Approval waits for Git to finish').toBe('reviewable')
  await expect(call('tasks:approve', { taskId: task.id, preview })).rejects.toThrow(/already busy/)
  mergeState.finish!()
  const approved: Task = await pendingApproval
  expect(mergeCalls.map((args) => args.slice(0, 3))).toStrictEqual([[testHome, 'task', preview], [testHome, 'task', preview]])
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

test('system terminals use registered project paths and propagate launch failures', async () => {
  const { call, project, store } = setupIpc()
  expect(store.getTasks()).toHaveLength(0)
  await call('projects:open-terminal', project.id)
  expect(openSystemTerminal).toHaveBeenCalledWith(project.path)
  vi.mocked(openSystemTerminal).mockRejectedValueOnce(new Error('No terminal'))
  await expect(call('projects:open-terminal', project.id)).rejects.toThrow('No terminal')
  await call('projects:remove', project.id)
  expect(() => call('projects:open-terminal', project.id)).toThrow('Project not found')
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
      expect(dispatched.prompt).toContain('Project memory\nInspect image')
      expect(task.prompt).toBe('Inspect image')
      expect(task.deliveryStatus).toBe(repository ? 'working' : 'unavailable')
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
    const { call, project, store, tick, agentProcesses } = setupIpc(async (_projectId, prompt) => {
      prepared()
      await pending
      if (action === 'failure') throw new Error('Memory unavailable')
      return prompt
    })
    const starting: Promise<Task> = call('tasks:start', { projectId: project.id, agentId: 'codex', prompt: 'Inspect image', images })
    await entered
    const task = store.getTasks().find((task) => task.prompt === 'Inspect image')!
    if (action !== 'failure') call(action, task.id)
    finish()
    if (action === 'tasks:delete') await expect(starting).rejects.toThrow('Task was deleted')
    else await starting
    await tick()
    expect(agentProcesses.starts).toHaveLength(0)
    expect(store.taskImages.read(task.id)).toBeUndefined()
    expect(store.getTask(task.id)?.branchName).toBeUndefined()
    if (action === 'failure') expect(store.getTask(task.id)?.error).toBe('Memory unavailable')
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
  const reopened = new Store(databaseFile, { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') })
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

test('file references reach fake agents as paths for worktrees and non-Git tasks, persist, and reject disappeared files before creation', async () => {
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
    expect(start.prompt).toContain(JSON.stringify([path]))
    expect(start.prompt).toContain(`Original project directory: ${JSON.stringify(project.path)}`)
    expect(start.prompt).toContain('Untracked files and uncommitted edits')
    expect(start.prompt).toContain('If a task copy is absent')
    expect(start.prompt).not.toContain(secret)
    expect(task.prompt).toContain(JSON.stringify([path]))
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


test('stacked start validates ownership and passes the parent commit to branch preparation', async () => {
  const { store, call, gitDelivery, tick } = setupIpc()
  const parent = await call('tasks:start', { projectId: 'project', agentId: 'codex', prompt: 'Parent' }) as Task
  await tick()
  const stackBase = vi.fn(async () => ({ commit: 'parent-tip', branch: parent.branchName! }))
  Object.assign(gitDelivery, { stackBase })
  const prepare = vi.spyOn(gitDelivery, 'prepareBranch')
  const child = await call('tasks:start', { projectId: 'project', agentId: 'codex', prompt: 'Child', parentTaskId: parent.id }) as Task
  expect(child.parentTaskId).toBe(parent.id)
  expect(store.getTask(child.id)?.parentTaskId).toBe(parent.id)
  expect(prepare).toHaveBeenCalledWith(testHome, child.id, expect.any(Function), { commit: 'parent-tip', branch: parent.branchName })
  const count = store.getTasks().length
  await expect(call('tasks:start', { projectId: 'project', agentId: 'codex', prompt: 'Invalid', parentTaskId: 'missing' })).rejects.toThrow('same project')
  expect(store.getTasks()).toHaveLength(count)
})
