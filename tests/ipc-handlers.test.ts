import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
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
import { registerSettingsHandlers } from '../src/main/ipc/settings'
import { registerTerminalHandlers } from '../src/main/ipc/terminals'
import { createTaskMemory } from '../src/main/memory/task-memory'
import { createTaskCompletion } from '../src/main/tasks/completion'
import { registerTaskEvents } from '../src/main/tasks/events'
import { registerTaskExecution } from '../src/main/tasks/task-execution'
import { titleFor } from '../src/main/tasks/task-title'
import { Store } from '../src/main/store'
import type { TerminalManager } from '../src/main/terminal'
import type { Project, RebaseStep, Task, TaskComment, TaskEvent } from '../src/shared/types'
import { AgentProcessManager, GitDeliveryManager, handlers, testHome } from './issue-tracker-doubles'

async function main(): Promise<void> {
  const store = new Store(join(testHome, 'ipc.db'), { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') })
  const tasks = { get: (id: string) => store.getTask(id), has: (id: string) => !!store.getTask(id) }
  const trackers = { get: (id: string) => taskState(store, id) }
  const events: TaskEvent[] = []
  const notifications: { channel: string; payload: unknown }[] = []
  const project: Project = {
    id: 'project', name: 'Project', path: testHome, createdAt: 0,
    monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github'
  }
  store.addProject(project)
  const agentProcesses = new AgentProcessManager()
  const gitDelivery = new GitDeliveryManager()
  const rebaseCalls: unknown[][] = []
  const mergeCalls: unknown[][] = []
  const pushCalls: unknown[][] = []
  let mergeFailure = false
  let finishMerge: (() => void) | undefined
  const delivery = Object.assign(gitDelivery, {
    async getPullRequestPreview() {
      return { sourceBranch: 'task', targetBranch: 'main', sourceCommit: 'source', targetCommit: 'target', remoteTargetCommit: 'remote-target', repository: 'developer/project', remote: 'origin', commitCount: 2 }
    },
    async pushPullRequestBranch(...args: unknown[]) { pushCalls.push(args) },
    async merge(...args: unknown[]) {
      mergeCalls.push(args)
      if (mergeFailure) throw new Error('Merge conflict')
      await new Promise<void>((resolve) => { finishMerge = resolve })
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
  const execution = registerTaskExecution(context, completion)
  const reviewContext = { ...context, recordSystemEvent: taskEvents.recordSystemEvent, requireFinishedTask: execution.requireFinishedTask }
  const terminalCalls: unknown[][] = []
  const terminals = {
    create: (...args: unknown[]) => terminalCalls.push(['create', ...args]),
    write: (...args: unknown[]) => terminalCalls.push(['write', ...args]),
    resize: (...args: unknown[]) => terminalCalls.push(['resize', ...args])
  } as unknown as TerminalManager

  registerTaskHandlers({ ...context, ...taskEvents, ...execution, promptWithProjectMemory: memory.promptWithProjectMemory })
  registerSteeringHandlers({ ...context, ...taskEvents, resumeTask: execution.resumeTask })
  registerReviewHandlers(reviewContext)
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
  registerGitHubHandlers({ ...reviewContext, credentials, client })
  registerRebaseHandlers(reviewContext)
  registerTerminalHandlers(terminals)
  registerSettingsHandlers(context.store)
  registerAgentHandlers()
  registerProjectHandlers({ ...context, stopTask: execution.stopTask, terminals, getWindow: () => null })
  assert.deepEqual([...handlers.keys()].sort(), [
    'agents:list', 'agents:models', 'comments:add', 'comments:list', 'comments:remove', 'comments:send',
    'github:credential-status', 'github:set-token', 'github:remove-token', 'github:pr-preview', 'github:open-pr', 'github:draft-pr-field', 'github:open-pr-url',
    'projects:add', 'projects:git-init', 'projects:git-status', 'projects:list', 'projects:remove', 'projects:reveal', 'projects:update',
    'tasks:approve', 'tasks:cancel', 'tasks:delete', 'tasks:diff', 'tasks:events', 'tasks:list', 'tasks:merge-preview', 'tasks:rebase', 'tasks:rebase-agent', 'tasks:settle', 'tasks:start', 'tasks:steer',
    'settings:get', 'settings:set', 'terminal:ensure', 'terminal:resize', 'terminal:write'
  ].sort())
  const call = (name: string, input?: unknown): any => handlers.get(name)!(null, input)
  const tick = async (): Promise<void> => {
    for (let index = 0; index < 8; index++) await new Promise((resolve) => setImmediate(resolve))
  }

  assert.equal(titleFor('  First line\nSecond line'), 'First line')
  assert.equal(titleFor(' \n '), 'Untitled task')
  assert.equal(titleFor('a'.repeat(72)), 'a'.repeat(72))
  assert.equal(titleFor('a'.repeat(73)), `${'a'.repeat(71)}...`)
  assert.match(agentRebasePrompt('base'), /git reset --soft base/)
  assert.equal(await memory.promptWithProjectMemory(project.id, 'Task'), 'Task')
  assert.deepEqual(call('projects:list'), [project])
  assert.deepEqual(call('agents:list').map((agent: { id: string }) => agent.id), ['opencode', 'codex'])
  assert.throws(() => call('agents:models', 'missing'), /Unknown agent/)
  assert.throws(() => call('agents:models', 'pi'), /Unknown agent/)
  await assert.rejects(call('tasks:start', { projectId: project.id, agentId: 'pi', prompt: 'Unsupported agent' }), /Unknown agent/)
  store.setSettings({ defaultAgentId: 'pi', defaultModel: 'old-model' })
  const fallbackSettings = call('settings:get')
  assert.equal(fallbackSettings.defaultAgentId, 'opencode')
  assert.equal(fallbackSettings.defaultModel, call('agents:list')[0].defaultModel)
  assert.equal(call('settings:set', { confirmRebase: false }).defaultAgentId, 'opencode')
  const codexSettings = call('settings:set', { defaultAgentId: 'codex', defaultModel: 'selected-model' })
  assert.equal(codexSettings.defaultAgentId, 'codex')
  assert.equal(codexSettings.defaultModel, 'selected-model')
  assert.equal(call('terminal:ensure', { id: 'terminal', cwd: '/project', cols: 80, rows: 24 }), true)
  call('terminal:write', { id: 'terminal', data: 'pwd\r' })
  call('terminal:resize', { id: 'terminal', cols: 120, rows: 40 })
  assert.deepEqual(terminalCalls, [
    ['create', 'terminal', '/project', 80, 24], ['write', 'terminal', 'pwd\r'], ['resize', 'terminal', 120, 40]
  ])

  const task: Task = await call('tasks:start', { projectId: project.id, agentId: 'codex', model: 'chosen-model', reasoningEffort: 'high', prompt: 'Task title\nDetails' })
  await tick()
  assert.equal(task.title, 'Task title')
  assert.equal(agentProcesses.starts.length, 1)
  assert.match(agentProcesses.starts[0].prompt, /Do not change project files/)
  await assert.rejects(call('tasks:approve', { taskId: task.id }), /not finished/)
  await assert.rejects(call('tasks:merge-preview', task.id), /not finished/)
  await assert.rejects(call('github:pr-preview', task.id), /not finished/)
  await assert.rejects(call('github:open-pr-url', 'file:///etc/passwd'), /Invalid GitHub PR URL/)
  await assert.rejects(call('tasks:rebase-agent', task.id), /not finished/)
  const issue = { key: 'first', title: 'Change', description: 'One change', labels: [], priority: 'medium', dependencies: [], checklist: ['Test'], validation: 'Run test' }
  agentProcesses.plan(task.id, [issue, { ...issue, key: 'second', dependencies: ['first'] }])
  await tick()
  assert.equal(agentProcesses.starts.length, 2)
  assert.equal(agentProcesses.starts[1].reasoningEffort, 'high', 'Implementation inherits the original task effort')
  assert.equal(store.getTaskExecution(task.id)?.reasoningEffort, 'high')
  let tracker = trackers.get(task.id)!
  agentProcesses.emit('session', { taskId: task.id, sessionId: 'session' })
  agentProcesses.emit('usage', { taskId: task.id, inputTokens: 5, outputTokens: 2, cachedTokens: 0, totalTokens: 7, costUsd: 0.1 })
  agentProcesses.emit('usage', { taskId: task.id, inputTokens: 6, outputTokens: 2, cachedTokens: 0, totalTokens: 8, costUsd: 0.2 })
  agentProcesses.completeIssue(task.id, tracker.items[0].id, { checklist: [true], evidence: 'Test passed' })
  await tick()
  assert.equal(agentProcesses.starts.length, 3)
  assert.equal(tasks.get(task.id)?.status, 'running')
  assert.equal(tasks.get(task.id)?.totalTokens, 8, 'Usage events are snapshots within one process')
  tracker = trackers.get(task.id)!
  agentProcesses.emit('usage', { taskId: task.id, inputTokens: 2, outputTokens: 1, cachedTokens: 0, totalTokens: 3, costUsd: null })
  agentProcesses.completeIssue(task.id, tracker.items[1].id, { checklist: [true], evidence: 'Test passed' })
  await tick()
  assert.equal(tasks.get(task.id)?.deliveryStatus, 'reviewable')
  assert.equal(tasks.get(task.id)?.totalTokens, 11, 'Usage accumulates across sequential processes')
  assert.equal(tasks.get(task.id)?.costUsd, 0.2)
  assert.match((await call('tasks:diff', task.id)).patch, /base\.\.commit-/)

  assert.throws(() => call('comments:add', { taskId: task.id, body: ' ' }), /needs some text/)
  const draft: TaskComment[] = call('comments:add', { taskId: task.id, file: 'file.ts', side: 'additions', lineNumber: 9, body: ' Fix this ' })
  assert.equal(draft[0].body, 'Fix this')
  assert.match(reviewPrompt(draft), /file.ts:9 — Fix this/)
  const followup = await call('comments:send', task.id)
  await tick()
  assert.equal(followup.task.status, 'running')
  assert.ok(followup.comments[0].sentAt)
  assert.equal(agentProcesses.starts.at(-1).resumeSessionId, 'session')
  assert.match(agentProcesses.starts.at(-1).prompt, /file.ts:9 — Fix this/)
  assert.equal(agentProcesses.starts.at(-1).reasoningEffort, 'high')
  agentProcesses.finishTurn(task.id)
  await tick()
  assert.equal(tasks.get(task.id)?.deliveryStatus, 'reviewable', 'Review follow-ups finalize without replanning')
  await assert.rejects(call('comments:send', task.id), /no comments/)
  assert.deepEqual(await call('github:credential-status'), { configured: false })
  assert.deepEqual(await call('github:set-token', 'test-token'), { configured: true })
  assert.equal('githubToken' in store.getSettings(), false, 'Tokens stay out of ordinary settings')
  const prPreview = await call('github:pr-preview', task.id)
  assert.equal(prPreview.account, 'developer')
  const pullRequest = await call('github:open-pr', { taskId: task.id, preview: prPreview, title: 'User PR title', description: 'User PR description' })
  assert.equal(pullRequest.number, 7)
  assert.equal(pullRequest.title, 'User PR title')
  assert.equal(pullRequest.description, 'User PR description')
  assert.deepEqual(pushCalls, [[testHome, prPreview]])
  assert.equal(tasks.get(task.id)?.deliveryStatus, 'reviewable', 'Opening a PR does not approve locally')
  assert.ok(events.some((event) => event.text.includes(pullRequest.url)))
  assert.deepEqual(await call('github:remove-token'), { configured: false })

  const preview = await call('tasks:merge-preview', task.id)
  assert.equal(preview.sourceBranch, 'task')
  assert.equal(preview.targetBranch, 'main')
  assert.equal(preview.commitCount, 1)
  mergeFailure = true
  await assert.rejects(call('tasks:approve', { taskId: task.id, preview }), /Merge conflict/)
  assert.equal(tasks.get(task.id)?.deliveryStatus, 'reviewable')
  assert.equal(tasks.get(task.id)?.reviewedAt, undefined)
  mergeFailure = false
  const pendingApproval = call('tasks:approve', { taskId: task.id, preview })
  assert.equal(tasks.get(task.id)?.deliveryStatus, 'reviewable', 'Approval waits for Git to finish')
  await assert.rejects(call('tasks:approve', { taskId: task.id, preview }), /already being approved/)
  finishMerge!()
  const approved: Task = await pendingApproval
  assert.deepEqual(mergeCalls, [[testHome, 'task', preview], [testHome, 'task', preview]])
  assert.equal(approved.deliveryStatus, 'approved')
  assert.ok(approved.reviewedAt)
  await assert.rejects(call('tasks:merge-preview', task.id), /not awaiting review/)

  await call('tasks:rebase-agent', task.id)
  await tick()
  assert.equal(agentProcesses.starts.at(-1).resumeSessionId, 'session')
  assert.equal(agentProcesses.starts.at(-1).prompt, agentRebasePrompt('base'))
  agentProcesses.finishTurn(task.id)
  await tick()
  const startsBeforeRebase = agentProcesses.starts.length
  const steps: RebaseStep[] = [{ sha: 'commit', action: 'drop', message: '' }]
  const rebased: Task = await call('tasks:rebase', { taskId: task.id, steps })
  assert.equal(rebased.deliveryStatus, 'no_changes')
  assert.equal(rebased.headCommit, 'rebased')
  assert.equal(agentProcesses.starts.length, startsBeforeRebase)
  assert.deepEqual(rebaseCalls, [[testHome, task.id, 'task', 'base', steps]])
  assert.ok(events.some((event) => /dropping 1/.test(event.text)))

  const pendingRebase = call('tasks:rebase-agent', task.id)
  call('tasks:delete', task.id)
  await assert.rejects(pendingRebase, /Task was deleted/)
  await tick()
  assert.equal(agentProcesses.starts.length, startsBeforeRebase, 'Deletion during reopen prevents a late agent start')
  const eventCount = events.length
  agentProcesses.emit('event', { id: randomUUID(), taskId: task.id, text: 'late output' })
  agentProcesses.emit('usage', { taskId: task.id, totalTokens: 100 })
  agentProcesses.emit('session', { taskId: task.id, sessionId: 'late' })
  taskEvents.recordSystemEvent(task.id, 'late system event')
  assert.equal(events.length, eventCount)
  assert.equal(tasks.has(task.id), false)
  assert.ok(notifications.some((notification) => notification.channel === 'task:event'))
  assert.ok(notifications.some((notification) => notification.channel === 'task:updated'))
  const invalid: Task = await call('tasks:start', { projectId: project.id, agentId: 'codex', prompt: 'Invalid plan' })
  await tick()
  agentProcesses.finishTurn(invalid.id, 'Planning failed.', 1)
  await tick()
  assert.equal(tasks.get(invalid.id)?.status, 'pending')
  assert.equal(trackers.get(invalid.id)?.phase, 'blocked')

  const cancelled: Task = await call('tasks:start', { projectId: project.id, agentId: 'codex', prompt: 'Cancel between issues' })
  await tick()
  agentProcesses.plan(cancelled.id, [issue, { ...issue, key: 'second', dependencies: ['first'] }])
  await tick()
  const currentIssue = trackers.get(cancelled.id)!.items[0]
  const startsBeforeCancel = agentProcesses.starts.length
  agentProcesses.completeIssue(cancelled.id, currentIssue.id, { checklist: [true], evidence: 'Test passed' })
  assert.equal(call('tasks:cancel', cancelled.id), true)
  await tick()
  assert.equal(agentProcesses.starts.length, startsBeforeCancel)
  assert.equal(tasks.get(cancelled.id)?.status, 'cancelled')
  assert.equal(trackers.get(cancelled.id)?.phase, 'blocked')
  const pendingStart = call('tasks:start', { projectId: project.id, agentId: 'codex', prompt: 'Cancel preparation' })
  const preparing = store.getTasks().find((entry) => entry.title === 'Cancel preparation')!
  assert.equal(call('tasks:cancel', preparing.id), true)
  await pendingStart
  await tick()
  assert.equal(store.getTask(preparing.id)?.status, 'cancelled')
  assert.equal(store.getTask(preparing.id)?.worktreePath, undefined, 'Cancelled preparation must not create a worktree')
  assert.equal(agentProcesses.isRunning(preparing.id), false)
  const nativeEffortTask: Task = await call('tasks:start', {
    projectId: project.id, agentId: 'opencode', prompt: 'Use native reasoning effort',
    model: 'openrouter/deepseek/deepseek-v4', reasoningEffort: 'max'
  })
  await tick()
  assert.equal(agentProcesses.starts.at(-1).taskId, nativeEffortTask.id)
  assert.equal(agentProcesses.starts.at(-1).reasoningEffort, 'max')
  call('tasks:cancel', nativeEffortTask.id)
  await tick()
  GitDeliveryManager.repository = false
  const nonGitEffortTask: Task = await call('tasks:start', {
    projectId: project.id, agentId: 'codex', prompt: 'Use reasoning without Git',
    model: 'reasoner', reasoningEffort: 'native-max'
  })
  await tick()
  assert.equal(agentProcesses.starts.at(-1).taskId, nonGitEffortTask.id)
  assert.equal(agentProcesses.starts.at(-1).reasoningEffort, 'native-max')
  call('tasks:cancel', nonGitEffortTask.id)
  await tick()
  GitDeliveryManager.repository = true
  store.close()
  console.log('IPC handler tests passed: channel registration, execution, usage, review, rebase, deletion guards, failed planning, cancellation, prompts, and terminals.')
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1 })
  .finally(() => { rmSync(testHome, { recursive: true, force: true }) })
