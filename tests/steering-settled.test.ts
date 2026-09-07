import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentProcessManager as RealAgentProcessManager } from '../src/main/agents/process-manager'
import type { GitDeliveryManager as RealGitDeliveryManager } from '../src/main/git-delivery'
import { registerSteeringHandlers } from '../src/main/ipc/steering'
import { createTaskMemory } from '../src/main/memory/task-memory'
import { createTaskCompletion } from '../src/main/tasks/completion'
import { registerTaskEvents } from '../src/main/tasks/events'
import { registerTaskExecution } from '../src/main/tasks/task-execution'
import { Store } from '../src/main/store'
import type { Task } from '../src/shared/types'
import { AgentProcessManager, GitDeliveryManager, handlers, testHome } from './issue-tracker-doubles'

async function main(): Promise<void> {
  const databasePath = join(testHome, 'steering-settled.db')
  const options = { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') }
  const store = new Store(databasePath, options)
  try {
    store.addProject({
      id: 'project', name: 'Project', path: testHome, createdAt: 0,
      monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github'
    })
    const agentProcesses = new AgentProcessManager()
    const gitDelivery = new GitDeliveryManager()
    const context = {
      store, agentProcesses: agentProcesses as unknown as RealAgentProcessManager,
      gitDelivery: gitDelivery as unknown as RealGitDeliveryManager, send: () => {}
    }
    const taskEvents = registerTaskEvents(context)
    const memory = createTaskMemory(context)
    const execution = registerTaskExecution(context, createTaskCompletion(context, taskEvents.recordSystemEvent, memory))
    registerSteeringHandlers({ ...context, ...taskEvents, ...execution })
    const steer = (taskId: string, message = 'One more instruction'): Promise<void> =>
      handlers.get('tasks:steer')!(null, { taskId, message })
    const tick = async (): Promise<void> => {
      for (let index = 0; index < 8; index++) await new Promise((resolve) => setImmediate(resolve))
    }
    const baseTask = {
      projectId: 'project', title: 'Base', prompt: 'Base prompt', agentId: 'codex', agentLabel: 'Codex',
      cwd: testHome, branchName: 'task-branch', worktreePath: testHome, baseCommit: 'base', baseBranch: 'main',
      startedAt: 1, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: 0,
      filesChanged: 1, additions: 1, deletions: 0
    }
    const addTask = (id: string, patch: Partial<Task>): Task => {
      const task: Task = { ...baseTask, id, ...patch }
      store.addTask(task)
      store.saveTaskExecution({
        taskId: id, projectPath: testHome, phase: 'complete', issueIds: [], currentIssueId: null,
        reasoningEffort: 'high', error: null
      })
      return task
    }

    addTask('settled', {
      status: 'succeeded', deliveryStatus: 'reviewable', sessionId: 'saved-session', endedAt: 2, settledAt: 3
    })
    await assert.rejects(steer('settled'), /settled and cannot receive new instructions/)
    assert.equal(store.getTask('settled')?.status, 'succeeded', 'A settled task stays closed')
    assert.equal(store.getTask('settled')?.settledAt, 3, 'A rejected steer does not unsettle the task')
    assert.equal(agentProcesses.starts.length, 0, 'Settled tasks must not reach the resume path')
    assert.equal(agentProcesses.steering.length, 0, 'Settled tasks must not reach the live steering path')

    addTask('stopped', {
      status: 'succeeded', deliveryStatus: 'reviewable', sessionId: 'stopped-session', endedAt: 2
    })
    await steer('stopped', 'Continue from the saved session')
    await tick()
    const resumed = agentProcesses.starts.at(-1)
    assert.equal(resumed.taskId, 'stopped')
    assert.equal(resumed.agent.id, 'codex')
    assert.equal(resumed.resumeSessionId, 'stopped-session')
    assert.equal(resumed.model, undefined)
    assert.equal(resumed.reasoningEffort, 'high')
    assert.equal(resumed.projectPath, testHome)
    assert.match(resumed.prompt, /Continue from the saved session$/)
    assert.equal(store.getTask('stopped')?.status, 'running', 'A stopped non-settled task resumes')
    assert.ok(store.readEvents('stopped').some((event) => event.text === 'You:\nContinue from the saved session'))

    addTask('running', {
      status: 'running', deliveryStatus: 'working', sessionId: 'live-session'
    })
    const startsBeforeSteering = agentProcesses.starts.length
    agentProcesses.active.add('running')
    await steer('running', 'Live adjustment')
    assert.deepEqual(agentProcesses.steering, [
      { taskId: 'running', sessionId: 'live-session', message: 'Live adjustment' }
    ])
    assert.equal(agentProcesses.starts.length, startsBeforeSteering, 'Live steering must not restart the task')
    assert.equal(store.getTask('running')?.status, 'running', 'A running task keeps running through steering')
    assert.equal(store.getTask('running')?.sessionId, 'live-session')
    assert.ok(store.readEvents('running').some((event) => event.text === 'You:\nLive adjustment'))
  } finally {
    store.close()
  }
  console.log('Steering settled tests passed: settled rejection, stopped resume path, and unchanged running path.')
}
main()
  .catch((error) => { console.error(error); process.exitCode = 1 })
  .finally(() => { rmSync(testHome, { recursive: true, force: true }) })
