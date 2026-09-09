import { rendererEvent, rendererIpc } from './renderer-fixture'
import { expect, test } from 'vitest'
import { onTestCleanup } from './test-cleanup'
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

test('rejects settled steering and preserves stopped resume and live steering paths', async () => {
  const databasePath = join(testHome, 'steering-settled.db')
  const options = { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') }
  const store = new Store(databasePath, options)
  {
    store.addProject({
      id: 'project', name: 'Project', path: testHome, createdAt: 0,
      monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github'
    })
    const agentProcesses = new AgentProcessManager()
    onTestCleanup(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      await agentProcesses.close()
    })
    const gitDelivery = new GitDeliveryManager()
    const context = {
      store, agentProcesses: agentProcesses as unknown as RealAgentProcessManager,
      gitDelivery: gitDelivery as unknown as RealGitDeliveryManager, send: () => {}
    }
    const taskEvents = registerTaskEvents(context)
    const memory = createTaskMemory(context)
    const execution = registerTaskExecution({ ...context, recordSystemEvent: taskEvents.recordSystemEvent }, createTaskCompletion(context, taskEvents.recordSystemEvent, memory))
    registerSteeringHandlers(rendererIpc, { ...context, ...taskEvents, ...execution })
    const steer = (taskId: string, message = 'One more instruction'): Promise<void> =>
      handlers.get('tasks:steer')!(rendererEvent, { taskId, message })
    const tick = async (): Promise<void> => {
      for (let index = 0; index < 8; index++) await new Promise((resolve) => setImmediate(resolve))
    }
    const baseTask = {
      projectId: 'project', title: 'Base', prompt: 'Base prompt', agentId: 'codex', agentLabel: 'Codex',
      cwd: testHome, branchName: 'task-branch', baseCommit: 'base', baseBranch: 'main',
      startedAt: 1, inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: 0,
      filesChanged: 1, additions: 1, deletions: 0
    }
    const addTask = (id: string, patch: Partial<Task> & Pick<Task, 'status' | 'deliveryStatus'>): Task => {
      const task: Task = { ...baseTask, id, ...patch }
      store.addTask(task)
      store.saveTaskExecution({
        taskId: id, projectPath: testHome, parentIssueId: store.issueTracker('project').createParent({ anvilTaskId: id, title: task.title }).id, phase: 'complete', issueIds: [], currentIssueId: null,
        reasoningEffort: 'high', error: null
      })
      return task
    }

    addTask('settled', {
      status: 'succeeded', deliveryStatus: 'reviewable', sessionId: 'saved-session', endedAt: 2, settledAt: 3
    })
    await expect(steer('settled')).rejects.toThrow(/settled and cannot receive new instructions/)
    expect(store.getTask('settled')?.status, 'A settled task stays closed').toBe('succeeded')
    expect(store.getTask('settled')?.settledAt, 'A rejected steer does not unsettle the task').toBe(3)
    expect(agentProcesses.starts.length, 'Settled tasks must not reach the resume path').toBe(0)
    expect(agentProcesses.steering.length, 'Settled tasks must not reach the live steering path').toBe(0)

    addTask('stopped', {
      status: 'succeeded', deliveryStatus: 'reviewable', sessionId: 'stopped-session', endedAt: 2
    })
    await steer('stopped', 'Continue from the saved session')
    await tick()
    const resumed = agentProcesses.starts.at(-1)
    expect(resumed.taskId).toBe('stopped')
    expect(resumed.agent.id).toBe('codex')
    expect(resumed.resumeSessionId).toBe('stopped-session')
    expect(resumed.model).toBe(undefined)
    expect(resumed.reasoningEffort).toBe('high')
    expect(resumed.projectPath).toBe(testHome)
    expect(resumed.prompt).toMatch(/Continue from the saved session$/)
    expect(store.getTask('stopped')?.status, 'A stopped non-settled task resumes').toBe('running')
    expect(store.readEvents('stopped').some((event) => event.text === 'You:\nContinue from the saved session')).toBeTruthy()

    addTask('running', {
      status: 'running', deliveryStatus: 'working', sessionId: 'live-session'
    })
    const startsBeforeSteering = agentProcesses.starts.length
    agentProcesses.active.add('running')
    await steer('running', 'Live adjustment')
    expect(agentProcesses.steering).toStrictEqual([
      { taskId: 'running', sessionId: 'live-session', message: 'Live adjustment' }
    ])
    expect(agentProcesses.starts.length, 'Live steering must not restart the task').toBe(startsBeforeSteering)
    expect(store.getTask('running')?.status, 'A running task keeps running through steering').toBe('running')
    expect(store.getTask('running')?.sessionId).toBe('live-session')
    expect(store.readEvents('running').some((event) => event.text === 'You:\nLive adjustment')).toBeTruthy()
  }
})
