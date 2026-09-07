import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentProcessManager as RealAgentProcessManager } from '../src/main/agents/process-manager'
import type { GitDeliveryManager as RealGitDeliveryManager } from '../src/main/git-delivery'
import { getAgent } from '../src/main/agents/registry'
import { registerTaskHandlers } from '../src/main/ipc/tasks'
import { registerSteeringHandlers } from '../src/main/ipc/steering'
import { createTaskMemory } from '../src/main/memory/task-memory'
import { createTaskCompletion } from '../src/main/tasks/completion'
import { registerTaskEvents } from '../src/main/tasks/events'
import { registerTaskExecution } from '../src/main/tasks/task-execution'
import { Store } from '../src/main/store'
import type { Task } from '../src/shared/types'
import { AgentProcessManager, GitDeliveryManager, handlers, testHome } from './issue-tracker-doubles'

async function main(): Promise<void> {
  const databasePath = join(testHome, 'steering.db')
  const options = { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') }
  const store = new Store(databasePath, options)
  try {
    store.addProject({
      id: 'project', name: 'Project', path: testHome, createdAt: 0,
      monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github'
    })
    const agentProcesses = new AgentProcessManager()
    const gitDelivery = new GitDeliveryManager()
    const prepare = gitDelivery.prepare.bind(gitDelivery)
    gitDelivery.prepare = async () => ({ ...await prepare(), worktreePath: join(testHome, 'removed-worktree') })
    const context = {
      store, agentProcesses: agentProcesses as unknown as RealAgentProcessManager,
      gitDelivery: gitDelivery as unknown as RealGitDeliveryManager, send: () => {}
    }
    const taskEvents = registerTaskEvents(context)
    const memory = createTaskMemory(context)
    const execution = registerTaskExecution(context, createTaskCompletion(context, taskEvents.recordSystemEvent, memory))
    registerTaskHandlers({ ...context, ...taskEvents, ...execution, promptWithProjectMemory: memory.promptWithProjectMemory })
    registerSteeringHandlers({ ...context, ...taskEvents, ...execution })
    const call = (name: string, input?: unknown): any => handlers.get(name)!(null, input)
    const steer = (taskId: string, message = 'Check the empty state'): Promise<void> => call('tasks:steer', { taskId, message })
    const tick = async (): Promise<void> => {
      for (let index = 0; index < 8; index++) await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal(getAgent('codex')?.supportsSteering, true)
    assert.ok(!getAgent('opencode')?.supportsSteering)
    await assert.rejects(call('tasks:steer', null), /task ID/)
    await assert.rejects(call('tasks:steer', { taskId: 'task', message: 42 }), /needs some text/)
    await assert.rejects(steer('missing'), /Task not found/)
    const task: Task = await call('tasks:start', {
      projectId: 'project', agentId: 'codex', prompt: 'Original task', model: 'original-model', reasoningEffort: 'high'
    })
    await tick()
    await assert.rejects(steer(task.id, '  '), /needs some text/)
    await assert.rejects(steer(task.id), /session yet/)
    agentProcesses.emit('session', { taskId: task.id, sessionId: 'old-session' })
    agentProcesses.emit('session', { taskId: task.id, sessionId: 'latest-session' })
    await steer(task.id, '  Check the empty state  ')
    assert.deepEqual(agentProcesses.steering, [{ taskId: task.id, sessionId: 'latest-session', message: 'Check the empty state' }])
    assert.equal(agentProcesses.starts.length, 1, 'Live steering must not start or cancel an execution')
    assert.equal(store.getTask(task.id)?.prompt, 'Original task')
    assert.ok(store.readEvents(task.id).some((event) => event.text === 'You:\nCheck the empty state'))

    const originalSteer = agentProcesses.steer.bind(agentProcesses)
    agentProcesses.steer = async () => { throw new Error('Agent rejected steering') }
    const eventsBeforeRejection = store.readEvents(task.id).length
    await assert.rejects(steer(task.id), /Agent rejected/)
    assert.equal(store.readEvents(task.id).length, eventsBeforeRejection, 'Do not report rejected input as sent')
    agentProcesses.steer = originalSteer
    agentProcesses.active.delete(task.id)
    await assert.rejects(steer(task.id), /between turns/)
    agentProcesses.active.add(task.id)
    agentProcesses.emit('usage', { taskId: task.id, inputTokens: 10, outputTokens: 5, cachedTokens: 0, totalTokens: 15, costUsd: null })
    agentProcesses.finishTurn(task.id)
    await tick()
    const finished = store.getTask(task.id)!
    assert.equal(finished.status, 'succeeded')
    assert.equal(store.getTaskExecution(task.id)?.phase, 'complete')

    store.addTask({ ...finished, id: 'unsupported', agentId: 'opencode', status: 'running', deliveryStatus: 'working' })
    await assert.rejects(steer('unsupported'), /cannot accept input while running/)
    store.updateTask('unsupported', { status: 'failed', deliveryStatus: 'agent_failed' })
    store.updateTask(task.id, { deliveryStatus: 'finalizing' })
    await assert.rejects(steer(task.id), /not finished/)
    store.updateTask(task.id, { deliveryStatus: 'reviewable' })

    const originalReopen = gitDelivery.reopen.bind(gitDelivery)
    let releaseReopen!: () => void
    gitDelivery.reopen = async () => {
      await new Promise<void>((resolve) => { releaseReopen = resolve })
      return originalReopen()
    }
    const continuation = steer(task.id, 'Use the saved settings')
    await assert.rejects(steer(task.id), /already being sent/)
    // The UI sends no session or settings. Main must use the latest stored values,
    // even when a session update arrives while a worktree is being reopened.
    store.updateTask(task.id, { sessionId: 'newest-session' })
    store.setSettings({ defaultAgentId: 'opencode', defaultModel: 'unrelated-default' })
    releaseReopen()
    await continuation
    const resumed = agentProcesses.starts.at(-1)
    assert.equal(resumed.taskId, task.id)
    assert.equal(resumed.agent.id, 'codex')
    assert.equal(resumed.model, 'original-model')
    assert.equal(resumed.reasoningEffort, 'high')
    assert.equal(resumed.resumeSessionId, 'newest-session')
    assert.equal(resumed.projectPath, testHome)
    assert.equal(resumed.cwd, testHome)
    assert.match(resumed.prompt, /Use the saved settings$/)
    assert.doesNotMatch(resumed.prompt, /Do not change project files/)
    assert.equal(store.getTaskExecution(task.id)?.phase, 'complete', 'Follow-ups do not replan the task')
    agentProcesses.emit('usage', { taskId: task.id, inputTokens: 3, outputTokens: 2, cachedTokens: 0, totalTokens: 5, costUsd: null })
    agentProcesses.finishTurn(task.id)
    await tick()
    assert.equal(store.getTask(task.id)?.deliveryStatus, 'reviewable')
    assert.notEqual(store.getTask(task.id)?.headCommit, finished.headCommit, 'Follow-ups refresh the final task diff')
    assert.equal(store.getTask(task.id)?.totalTokens, 20)
    assert.equal(store.getTask(task.id)?.baseCommit, finished.baseCommit)

    // Reproduce a task left mid-finalization when Anvil closes itself.
    store.addTask({ ...finished, id: 'interrupted', status: 'cancelled', deliveryStatus: 'finalizing', error: 'Task cancelled.' })
    store.saveTaskExecution({ ...store.getTaskExecution(task.id)!, taskId: 'interrupted', phase: 'blocked' })
    const recovered = new Store(databasePath, options)
    assert.equal(recovered.getTask('interrupted')?.status, 'pending')
    assert.equal(recovered.getTask('interrupted')?.deliveryStatus, 'agent_failed')
    recovered.close()
    gitDelivery.reopen = originalReopen
    await steer('interrupted', 'Fix the already running error')
    assert.equal(agentProcesses.starts.at(-1).resumeSessionId, finished.sessionId)
    agentProcesses.finishTurn('interrupted')
    await tick()

    const state = store.getTaskExecution(task.id)!
    store.addTask({ ...finished, id: 'deleted' })
    store.saveTaskExecution({ ...state, taskId: 'deleted' })
    const startsBeforeDeletion = agentProcesses.starts.length
    const deletedSend = steer('deleted')
    call('tasks:delete', 'deleted')
    releaseReopen()
    await assert.rejects(deletedSend, /Task was deleted/)
    assert.equal(agentProcesses.starts.length, startsBeforeDeletion)

    gitDelivery.reopen = async () => { throw new Error('Reopen failed') }
    await assert.rejects(steer(task.id), /Reopen failed/)
    assert.equal(store.getTask(task.id)?.status, 'succeeded')
    gitDelivery.reopen = originalReopen
    const originalStart = agentProcesses.start.bind(agentProcesses)
    agentProcesses.start = () => { throw new Error('Executor unavailable') }
    await assert.rejects(steer(task.id), /Executor unavailable/)
    assert.equal(store.getTask(task.id)?.status, 'succeeded', 'A failed start restores the finished task')
    agentProcesses.start = originalStart

    store.addTask({ ...finished, id: 'unmanaged', branchName: undefined, worktreePath: undefined, baseCommit: undefined, deliveryStatus: 'unavailable' })
    store.saveTaskExecution({ ...state, taskId: 'unmanaged' })
    await steer('unmanaged', 'Continue without Git')
    assert.equal(agentProcesses.starts.at(-1).prompt, 'Continue without Git')
    assert.equal(agentProcesses.starts.at(-1).resumeSessionId, finished.sessionId)
    agentProcesses.finishTurn('unmanaged')
    await tick()
    assert.equal(store.getTask('unmanaged')?.deliveryStatus, 'unavailable')
  } finally {
    store.close()
  }
  const restarted = new Store(databasePath, options)
  try {
    const task = restarted.getTasks().find((task) => task.prompt === 'Original task' && task.id !== 'unsupported' && task.id !== 'unmanaged')!
    assert.equal(task.model, 'original-model')
    assert.equal(task.sessionId, 'newest-session')
    assert.equal(restarted.getTaskExecution(task.id)?.reasoningEffort, 'high', 'Reasoning settings survive restart')
  } finally {
    restarted.close()
  }
  console.log('Task steering passed: capability checks, latest session, live input, inherited settings, restart persistence, resumption, delivery, usage, duplicates, deletion, and errors.')
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1 })
  .finally(() => { rmSync(testHome, { recursive: true, force: true }) })
