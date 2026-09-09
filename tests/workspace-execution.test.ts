import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { expect, test, vi } from 'vitest'
import { AgentProcessManager, type ExitInfo } from '../src/main/agents/process-manager'
import type { AgentExecutor, TaskInput, TaskResult } from '../src/main/agents/agent-executor'
import { CodexAppServerClient } from '../src/main/agents/codex-app-server'
import { OpenCodeAcpClient } from '../src/main/agents/opencode-acp'
import { registerAgentAdapter } from '../src/main/agents/adapters'
import { invalidateWorkspaceModels, listModels } from '../src/main/agents/models'
import { resolveTaskWorkspace, resolveWorkspaceExecution, type WorkspaceExecutionContext } from '../src/main/agents/workspace-execution'
import { watchWorkspaceAuthChanges } from '../src/main/agents/workspace-auth-changes'
import { draftPullRequestField } from '../src/main/agents/pull-request-draft'
import { getAgent } from '../src/main/agents/registry'
import { Store } from '../src/main/store'
import { resumeTaskTurn } from '../src/main/tasks/resume'
import { withTaskOperation } from '../src/main/tasks/operations'
import type { TaskContext } from '../src/main/tasks/context'
import type { Task, ProviderModelList, AgentDefinition } from '../src/shared/types'
import { useStore } from '../src/renderer/src/state/store'
import { GitDeliveryManager, testHome } from './issue-tracker-doubles'
import { onTestCleanup } from './test-cleanup'

function fixture(): { store: Store; work: string; personal: string; task: Task; database: string } {
  const database = join(testHome, randomUUID(), 'anvil.db')
  const store = new Store(database, { migrationsFolder: resolve('src/main/db/migrations') })
  onTestCleanup(() => store.close())
  const work = store.createWorkspace('Work').id
  const personal = store.createWorkspace('Personal').id
  store.selectWorkspace(work)
  store.addProject({ id: 'project', name: 'Project', path: testHome, createdAt: 0,
    monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
  const task = store.addTask({ id: 'work-task', workspaceId: work, projectId: 'project',
    agentId: 'codex', agentLabel: 'Codex', prompt: 'Work task', title: 'Work task', cwd: testHome,
    status: 'running', deliveryStatus: 'unavailable', startedAt: 1,
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null,
    filesChanged: 0, additions: 0, deletions: 0 })
  return { store, work, personal, task, database }
}

test('captures immutable profiles without inheriting provider credentials or global config pointers', async () => {
  const { store, work, personal } = fixture()
  const inherited = { PATH: '/runtime/bin', HTTPS_PROXY: 'http://proxy:8080', LANG: 'en_US.UTF-8',
    ANVIL_DATABASE_PATH: '/anvil.db', HOME: '/real-home', CODEX_HOME: '/global-codex',
    OPENAI_API_KEY: 'work-secret', ANTHROPIC_API_KEY: 'other-secret', AWS_PROFILE: 'work',
    AWS_ACCESS_KEY_ID: 'cloud-secret', GOOGLE_APPLICATION_CREDENTIALS: '/cloud.json',
    OPENCODE_CONFIG: '/global.json', OPENCODE_CONFIG_CONTENT: '{"key":"secret"}',
    XDG_DATA_HOME: '/global-data', NODE_OPTIONS: '--require=/global.js', GIT_CONFIG_GLOBAL: '/global-git' }
  const before = { ...inherited }
  const context = resolveWorkspaceExecution(store, work, inherited)
  store.selectWorkspace(personal)
  inherited.OPENAI_API_KEY = 'changed-secret'
  expect(context.workspaceId).toBe(work)
  expect(context.environment).toMatchObject({ PATH: '/runtime/bin', HTTPS_PROXY: 'http://proxy:8080',
    LANG: 'en_US.UTF-8', ANVIL_DATABASE_PATH: store.getWorkspaceDatabasePath(work), HOME: context.home, CODEX_HOME: context.codexHome })
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_PROFILE', 'AWS_ACCESS_KEY_ID',
    'GOOGLE_APPLICATION_CREDENTIALS', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'NODE_OPTIONS', 'GIT_CONFIG_GLOBAL']) {
    expect(context.environment[key], key).toBeUndefined()
  }
  expect(inherited).toEqual({ ...before, OPENAI_API_KEY: 'changed-secret' })
  expect(Object.isFrozen(context)).toBe(true)
  expect(Object.isFrozen(context.environment)).toBe(true)
  expect(resolveWorkspaceExecution(store, personal).home).not.toBe(context.home)
  expect(() => resolveWorkspaceExecution(store, '../escape')).toThrow()
  const globalGit = join(testHome, 'global-gitconfig')
  await writeFile(globalGit, '[user]\nname = Shared Author\nemail = shared@example.invalid\n[credential]\nhelper = private-helper\n')
  const identity = resolveWorkspaceExecution(store, store.createWorkspace('Identity').id, { ...process.env, GIT_CONFIG_GLOBAL: globalGit })
  expect(await readFile(join(identity.home, '.gitconfig'), 'utf8')).not.toContain('credential')
  expect(execFileSync('git', ['config', '--global', '--get', 'user.email'], { env: identity.environment, encoding: 'utf8' }).trim()).toBe('shared@example.invalid')
})

test('keeps concurrent Work and Personal turns, steering and metadata on their owner, then closes every client', async () => {
  const { store, work, personal, task } = fixture()
  const inputs: TaskInput[] = []
  const closed: string[] = []
  const steered: string[] = []
  const created: string[] = []
  const manager = new AgentProcessManager(undefined, undefined, (agentId, workspace) => {
    created.push(`${workspace.workspaceId}:${agentId}`)
    return {
      async execute(input): Promise<TaskResult> {
        inputs.push(input)
        expect(input.workspace.workspaceId).toBe(workspace.workspaceId)
        if (input.prompt === 'fail') throw new Error('Startup failed')
        input.onStarted?.()
        if (input.readOnly) return { taskId: input.taskId, status: 'succeeded', output: 'Work PR', changedFiles: [] }
        await new Promise<void>((resolve) => {
          if (input.signal?.aborted) resolve()
          else input.signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        return { taskId: input.taskId, status: 'cancelled', output: '', changedFiles: [] }
      },
      async steer() { steered.push(workspace.workspaceId) },
      async close() { closed.push(`${workspace.workspaceId}:${agentId}`) }
    }
  }, (id) => resolveTaskWorkspace(store, id))
  onTestCleanup(() => manager.close())
  const agent = getAgent('codex')!
  const workspace = resolveTaskWorkspace(store, task.id)
  manager.start({ workspace, taskId: task.id, agent, cwd: testHome, prompt: 'Work' })
  store.addProject(store.getProjects(work)[0], personal)
  store.selectWorkspace(personal)
  const personalTask = store.addTask({ ...task, id: 'personal-task', workspaceId: personal })
  manager.start({ workspace: resolveTaskWorkspace(store, personalTask.id), taskId: personalTask.id, agent, cwd: testHome, prompt: 'Personal' })
  expect(manager.isRunning(task.id)).toBe(true)
  expect(manager.isRunning(personalTask.id)).toBe(true)
  await manager.steer({ taskId: task.id, sessionId: 'work-session', message: 'Continue' })
  expect(steered).toEqual([work])
  expect(await draftPullRequestField(manager, workspace, task, { patch: '', commits: [] }, 'title', '', '')).toBe('Work PR')
  expect(inputs.at(-1)?.workspace.workspaceId).toBe(work)
  expect(inputs.at(-1)?.resumeSessionId).toBeUndefined()
  await expect(draftPullRequestField(manager, resolveTaskWorkspace(store, personalTask.id), task,
    { patch: '', commits: [] }, 'title', '', '')).rejects.toThrow(/workspace/)
  expect(created).toEqual([`${work}:codex`, `${personal}:codex`])
  const cancelled = once(manager, 'exit')
  manager.cancel(personalTask.id)
  expect(((await cancelled)[0] as ExitInfo).cancelled).toBe(true)
  expect(manager.isRunning(task.id)).toBe(true)
  await expect(manager.startResumed({ taskId: personalTask.id, workspace: resolveTaskWorkspace(store, personalTask.id),
    agent, cwd: testHome, prompt: 'fail' })).rejects.toThrow('Startup failed')
  expect(manager.isRunning(personalTask.id)).toBe(false)
  expect(() => manager.start({ taskId: personalTask.id, workspace, agent, cwd: testHome, prompt: 'wrong owner' })).toThrow(/persisted owner/)
  expect(() => manager.start({ taskId: 'not-persisted', workspace, agent, cwd: testHome, prompt: 'missing task' })).toThrow('Task not found')
  await manager.close()
  expect(manager.isRunning(task.id)).toBe(false)
  expect(closed.sort()).toEqual(created.sort())
})

test('resumes an old session after switching and SQLite restart with its saved owner and settings', async () => {
  const { store, work, personal, task, database } = fixture()
  store.updateTask(task.id, { status: 'succeeded', sessionId: 'work-session' })
  store.saveTaskExecution({ taskId: task.id, projectPath: testHome, parentIssueId: 'saved-parent', phase: 'complete',
    issueIds: [], currentIssueId: null, error: null, reasoningEffort: 'high' })
  store.selectWorkspace(personal)
  store.close()
  const restarted = new Store(database, { migrationsFolder: resolve('src/main/db/migrations') })
  onTestCleanup(() => restarted.close())
  const inputs: TaskInput[] = []
  const executor: AgentExecutor = {
    async execute(input) {
      inputs.push(input)
      input.onStarted?.()
      return { taskId: input.taskId, status: 'succeeded', output: 'done', changedFiles: [] }
    }
  }
  const manager = new AgentProcessManager(executor, executor, undefined, (id) => resolveTaskWorkspace(restarted, id))
  onTestCleanup(() => manager.close())
  const context: TaskContext = { store: restarted, agentProcesses: manager,
    gitDelivery: new GitDeliveryManager() as unknown as TaskContext['gitDelivery'], send: () => {} }
  await withTaskOperation(restarted, task.id, 'steer', (check) => resumeTaskTurn(context, {
    check, validate: () => {}, prompt: () => 'Follow up'
  }))
  expect(restarted.getActiveWorkspace().id).toBe(personal)
  expect(inputs[0]).toMatchObject({ workspace: { workspaceId: work }, resumeSessionId: 'work-session', reasoningEffort: 'high' })
  expect(restarted.getTasks(personal)).toEqual([])
  expect(restarted.getTask(task.id)?.workspaceId).toBe(work)
})

test('launches separate real protocol processes using each profile environment', async () => {
  const { store, work, personal } = fixture()
  vi.stubEnv('OPENAI_API_KEY', 'inherited-secret')
  for (const protocol of ['codex', 'acp'] as const) {
    const transcripts = new Map<string, string>()
    const manager = new AgentProcessManager(undefined, undefined, (_agentId, workspace) => {
      const transcript = join(testHome, `${protocol}-${workspace.workspaceId}.jsonl`)
      transcripts.set(workspace.workspaceId, transcript)
      const options = { command: process.execPath, args: [resolve('tests/fixtures/agent-server-lifecycle.cjs'), protocol, transcript],
        serverCwd: workspace.home, environment: workspace.environment, cancelTimeoutMs: 100 }
      return protocol === 'codex' ? new CodexAppServerClient({ ...options, workspace }) : new OpenCodeAcpClient(options)
    })
    onTestCleanup(() => manager.close())
    const agent = getAgent(protocol === 'codex' ? 'codex' : 'opencode')!
    const first = manager.startResumed({ taskId: 'work', workspace: resolveWorkspaceExecution(store, work), agent, cwd: testHome, prompt: 'cancel-me' })
    await first
    store.selectWorkspace(personal)
    await manager.startResumed({ taskId: 'personal', workspace: resolveWorkspaceExecution(store, personal), agent, cwd: testHome, prompt: 'cancel-me' })
    expect(manager.isRunning('work')).toBe(true)
    const pids: number[] = []
    for (const workspaceId of [work, personal]) {
      const spawn = JSON.parse((await readFile(transcripts.get(workspaceId)!, 'utf8')).split('\n')[0])
      const workspace = resolveWorkspaceExecution(store, workspaceId)
      expect(spawn).toMatchObject({ home: workspace.home, codexHome: workspace.codexHome, dataHome: workspace.environment.XDG_DATA_HOME })
      expect(spawn.inheritedKey).toBeUndefined()
      pids.push(spawn.pid)
    }
    expect(new Set(pids).size).toBe(2)
    await manager.close()
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow()
  }
})

test('scopes discovery and authentication invalidation by workspace and rejects stale renderer results', async () => {
  const { store, work, personal } = fixture()
  let release: ((catalogue: { models: string[] }) => void) | undefined
  let delayed = false
  const adapterId = `workspace-${randomUUID()}`
  const discover = vi.fn(async (_agent: AgentDefinition, workspace: WorkspaceExecutionContext) => {
    if (delayed) return new Promise<{ models: string[] }>((resolve) => { release = resolve })
    return { models: [workspace.workspaceId] }
  })
  registerAgentAdapter({ id: adapterId, createExecutor: () => { throw new Error('unused') }, listModels: discover })
  const agent = { ...getAgent('codex')!, id: adapterId, models: { kind: 'adapter' as const, adapterId } }
  const workContext = resolveWorkspaceExecution(store, work)
  const personalContext = resolveWorkspaceExecution(store, personal)
  expect((await listModels(agent, workContext)).models).toEqual([work])
  expect((await listModels(agent, personalContext)).models).toEqual([personal])
  invalidateWorkspaceModels(work)
  await listModels(agent, personalContext)
  expect(discover).toHaveBeenCalledTimes(2)
  delayed = true
  const stale = listModels(agent, workContext)
  invalidateWorkspaceModels(work)
  release!({ models: ['old-account'] })
  expect((await stale).error).toMatch(/authentication changed/)
  delayed = false
  expect((await listModels(agent, workContext)).models).toEqual([work])
  const changes: string[] = []
  onTestCleanup(watchWorkspaceAuthChanges(store, (id) => changes.push(id)))
  await writeFile(join(workContext.codexHome, 'auth.json'), '{}')
  await expect.poll(() => changes.includes(work)).toBe(true)
  expect(changes).not.toContain(personal)

  const original = useStore.getState()
  onTestCleanup(() => useStore.setState(original, true))
  let respond!: (list: ProviderModelList) => void
  vi.stubGlobal('window', { anvil: { agents: { models: vi.fn(() => new Promise<ProviderModelList>((resolve) => { respond = resolve })) } } })
  useStore.setState({ activeWorkspaceId: work, workspaceSwitching: false, modelsByAgent: {}, modelsByWorkspace: {}, loadingModelsAgentId: null })
  const pending = useStore.getState().loadAgentModels('codex')
  useStore.getState().invalidateAgentModels(work)
  respond({ agentId: 'codex', models: ['old-account'] })
  await pending
  expect(useStore.getState().modelsByAgent).toEqual({})
  const current = useStore.getState().loadAgentModels('codex')
  respond({ agentId: 'codex', models: ['new-account'] })
  await current
  useStore.getState().invalidateAgentModels(personal)
  expect(useStore.getState().modelsByWorkspace[work].codex.models).toEqual(['new-account'])
  const switched = useStore.getState().loadAgentModels('opencode')
  useStore.setState({ activeWorkspaceId: personal, modelsByAgent: {}, loadingModelsAgentId: null })
  respond({ agentId: 'opencode', models: ['work-only'] })
  await switched
  expect(useStore.getState().modelsByAgent).toEqual({})
})

test('shutdown cancels and awaits an owned model discovery process', async () => {
  vi.resetModules()
  const discovery = await import('../src/main/agents/models')
  onTestCleanup(() => discovery.closeModelDiscovery())
  const { store, work } = fixture()
  const pidFile = join(testHome, 'model-discovery.pid')
  const pending = discovery.listModels({ ...getAgent('codex')!, models: {
    kind: 'command', command: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`]
  } }, resolveWorkspaceExecution(store, work))
  let pid = 0
  await expect.poll(async () => {
    try { pid = Number(await readFile(pidFile, 'utf8')) } catch { return false }
    return pid > 0
  }).toBe(true)
  await discovery.closeModelDiscovery()
  expect((await pending).error).toBeTruthy()
  expect(() => process.kill(pid, 0)).toThrow()
})
