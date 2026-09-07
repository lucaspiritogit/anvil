import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { taskState } from './task-state'
import type { AgentProcessManager as RealAgentProcessManager } from '../src/main/agents/process-manager'
import { agentRebasePrompt, reviewPrompt } from '../src/main/agents/task-prompts'
import type { GitDeliveryManager as RealGitDeliveryManager } from '../src/main/git-delivery'
import { registerAgentHandlers } from '../src/main/ipc/agents'
import { registerProjectHandlers } from '../src/main/ipc/projects'
import { registerRebaseHandlers } from '../src/main/ipc/rebase'
import { registerReviewHandlers } from '../src/main/ipc/review'
import { registerTaskHandlers } from '../src/main/ipc/tasks'
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
  const delivery = Object.assign(gitDelivery, {
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
  registerReviewHandlers(reviewContext)
  registerRebaseHandlers(reviewContext)
  registerTerminalHandlers(terminals)
  registerSettingsHandlers(context.store)
  registerAgentHandlers()
  registerProjectHandlers({ ...context, stopTask: execution.stopTask, terminals, getWindow: () => null })
  assert.deepEqual([...handlers.keys()].sort(), [
    'agents:list', 'agents:models', 'comments:add', 'comments:list', 'comments:remove', 'comments:send',
    'projects:add', 'projects:git-init', 'projects:git-status', 'projects:list', 'projects:remove', 'projects:reveal', 'projects:update',
    'tasks:approve', 'tasks:cancel', 'tasks:delete', 'tasks:diff', 'tasks:events', 'tasks:list', 'tasks:rebase', 'tasks:rebase-agent', 'tasks:settle', 'tasks:start',
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

  const task: Task = await call('tasks:start', { projectId: project.id, agentId: 'codex', prompt: 'Task title\nDetails' })
  await tick()
  assert.equal(task.title, 'Task title')
  assert.equal(agentProcesses.starts.length, 1)
  assert.match(agentProcesses.starts[0].prompt, /Do not change project files/)
  assert.throws(() => call('tasks:approve', task.id), /not finished/)
  await assert.rejects(call('tasks:rebase-agent', task.id), /not finished/)
  const issue = { key: 'first', title: 'Change', description: 'One change', labels: [], priority: 'medium', dependencies: [], checklist: ['Test'], validation: 'Run test' }
  agentProcesses.plan(task.id, [issue, { ...issue, key: 'second', dependencies: ['first'] }])
  await tick()
  assert.equal(agentProcesses.starts.length, 2)
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
  agentProcesses.finishTurn(task.id)
  await tick()
  assert.equal(tasks.get(task.id)?.deliveryStatus, 'reviewable', 'Review follow-ups finalize without replanning')
  await assert.rejects(call('comments:send', task.id), /no comments/)
  const approved: Task = call('tasks:approve', task.id)
  assert.equal(approved.deliveryStatus, 'approved')
  assert.ok(approved.reviewedAt)

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
  assert.equal(tasks.get(invalid.id)?.status, 'failed')
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
    projectId: project.id, agentId: 'opencode', prompt: 'Use native model effort',
    model: 'openrouter/deepseek/deepseek-v4', modelEffort: 'max'
  })
  await tick()
  assert.equal(agentProcesses.starts.at(-1).taskId, nativeEffortTask.id)
  assert.equal(agentProcesses.starts.at(-1).modelEffort, 'max')
  assert.equal(agentProcesses.starts.at(-1).thinkingLevel, undefined)
  call('tasks:cancel', nativeEffortTask.id)
  await tick()
  store.close()
  console.log('IPC handler tests passed: channel registration, execution, usage, review, rebase, deletion guards, failed planning, cancellation, prompts, and terminals.')
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1 })
  .finally(() => { rmSync(testHome, { recursive: true, force: true }) })
