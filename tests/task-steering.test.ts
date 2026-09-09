import { rendererEvent, rendererIpc } from './renderer-fixture'
import { expect, test } from 'vitest'
import { onTestCleanup } from './test-cleanup'
import { join } from 'node:path'
import type { AgentProcessManager as RealAgentProcessManager } from '../src/main/agents/process-manager'
import type { GitDeliveryManager as RealGitDeliveryManager } from '../src/main/git-delivery'
import { getAgent } from '../src/main/agents/registry'
import { registerTaskHandlers } from '../src/main/ipc/tasks'
import { registerReviewHandlers } from '../src/main/ipc/review'
import { registerSteeringHandlers } from '../src/main/ipc/steering'
import { createTaskMemory } from '../src/main/memory/task-memory'
import { createTaskCompletion } from '../src/main/tasks/completion'
import { registerTaskEvents } from '../src/main/tasks/events'
import { registerTaskExecution } from '../src/main/tasks/task-execution'
import { TaskIssues } from '../src/main/tasks/task-issues'
import { Store } from '../src/main/store'
import type { Task } from '../src/shared/types'
import { AgentProcessManager, GitDeliveryManager, handlers, testHome } from './issue-tracker-doubles'

test('serializes steering and comments through resume, completion and recovery', async () => {
  const databasePath = join(testHome, 'steering.db')
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
    registerTaskHandlers(rendererIpc, { ...context, ...taskEvents, ...execution, promptWithProjectMemory: memory.promptWithProjectMemory })
    registerSteeringHandlers(rendererIpc, { ...context, ...taskEvents, ...execution })
    registerReviewHandlers(rendererIpc, { ...context, ...taskEvents, ...execution })
    const call = (name: string, input?: unknown): any => handlers.get(name)!(rendererEvent, input)
    const steer = (taskId: string, message = 'Check the empty state'): Promise<void> => call('tasks:steer', { taskId, message })
    const tick = async (): Promise<void> => {
      for (let index = 0; index < 8; index++) await new Promise((resolve) => setImmediate(resolve))
    }
    expect(getAgent('codex')?.supportsSteering).toBe(true)
    expect(!getAgent('opencode')?.supportsSteering).toBeTruthy()
    expect(() => call('tasks:steer', null)).toThrow(/Invalid IPC request/)
    expect(() => call('tasks:steer', { taskId: 'task', message: 42 })).toThrow(/Invalid IPC request/)
    await expect(steer('missing')).rejects.toThrow(/Task not found/)
    const task: Task = await call('tasks:start', {
      projectId: 'project', agentId: 'codex', prompt: 'Original task', model: 'original-model', reasoningEffort: 'high'
    })
    await tick()
    expect(() => steer(task.id, '  ')).toThrow(/Invalid IPC request/)
    await expect(steer(task.id)).rejects.toThrow(/session yet/)
    agentProcesses.emit('session', { taskId: task.id, sessionId: 'old-session' })
    agentProcesses.emit('session', { taskId: task.id, sessionId: 'latest-session' })
    await steer(task.id, '  Check the empty state  ')
    expect(agentProcesses.steering).toStrictEqual([{ taskId: task.id, sessionId: 'latest-session', message: 'Check the empty state' }])
    expect(agentProcesses.starts.length, 'Live steering must not start or cancel an execution').toBe(1)
    expect(store.getTask(task.id)?.prompt).toBe('Original task')
    expect(store.readEvents(task.id).some((event) => event.text === 'You:\nCheck the empty state')).toBeTruthy()

    const originalSteer = agentProcesses.steer.bind(agentProcesses)
    agentProcesses.steer = async () => { throw new Error('Agent rejected steering') }
    const eventsBeforeRejection = store.readEvents(task.id).length
    await expect(steer(task.id)).rejects.toThrow(/Agent rejected/)
    expect(store.readEvents(task.id).length, 'Do not report rejected input as sent').toBe(eventsBeforeRejection)
    agentProcesses.steer = originalSteer
    agentProcesses.active.delete(task.id)
    await expect(steer(task.id)).rejects.toThrow(/between turns/)
    agentProcesses.active.add(task.id)
    agentProcesses.emit('usage', { taskId: task.id, inputTokens: 10, outputTokens: 5, cachedTokens: 0, totalTokens: 15, costUsd: null })
    agentProcesses.finishTurn(task.id)
    await tick()
    const finished = store.getTask(task.id)!
    expect(finished.status).toBe('succeeded')
    expect(store.getTaskExecution(task.id)?.phase).toBe('complete')

    store.addTask({ ...finished, id: 'unsupported', agentId: 'opencode', status: 'running', deliveryStatus: 'working' })
    await expect(steer('unsupported')).rejects.toThrow(/cannot accept input while running/)
    store.updateTask('unsupported', { status: 'failed', deliveryStatus: 'agent_failed' })
    store.updateTask(task.id, { deliveryStatus: 'finalizing' })
    await expect(steer(task.id)).rejects.toThrow(/not finished/)
    store.updateTask(task.id, { deliveryStatus: 'reviewable' })

    const originalReopen = gitDelivery.checkoutBranch.bind(gitDelivery)
    let releaseReopen: (() => void) | undefined
    const pendingReopens: Promise<unknown>[] = []
    const trackReopen = <T,>(promise: Promise<T>): Promise<T> => {
      pendingReopens.push(promise)
      void promise.catch(() => {}) // Cleanup observes rejection if an earlier assertion fails.
      return promise
    }
    onTestCleanup(async () => {
      releaseReopen?.()
      await Promise.allSettled(pendingReopens)
    })
    gitDelivery.checkoutBranch = async () => {
      await new Promise<void>((resolve) => { releaseReopen = resolve })
      return originalReopen()
    }
    store.addComment({ id: 'review-note', taskId: task.id, body: 'Fix this', file: 'a.ts', side: 'additions', lineNumber: 1, createdAt: 0, sentAt: null })
    const reviewSend = trackReopen(call('comments:send', task.id))
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await expect(Promise.race([
        call('comments:send', task.id),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('Duplicate send waited for reopen')), 50)
        })
      ])).rejects.toThrow(/already/)
    } finally {
      clearTimeout(timeout)
    }
    await expect(steer(task.id)).rejects.toThrow(/already/)
    releaseReopen!()
    await reviewSend
    await tick()
    agentProcesses.finishTurn(task.id)
    await tick()
    const continuation = trackReopen(steer(task.id, 'Use the saved settings'))
    await expect(steer(task.id)).rejects.toThrow(/already being sent/)
    // The UI sends no session or settings. Main must use the latest stored values,
    // even when a session update arrives while a worktree is being reopened.
    store.updateTask(task.id, { sessionId: 'newest-session' })
    store.setSettings({ defaultAgentId: 'opencode', defaultModel: 'unrelated-default' })
    releaseReopen!()
    await continuation
    const resumed = agentProcesses.starts.at(-1)
    expect(resumed.taskId).toBe(task.id)
    expect(resumed.agent.id).toBe('codex')
    expect(resumed.model).toBe('original-model')
    expect(resumed.reasoningEffort).toBe('high')
    expect(resumed.resumeSessionId).toBe('newest-session')
    expect(resumed.projectPath).toBe(testHome)
    expect(resumed.cwd).toBe(testHome)
    expect(resumed.prompt).toMatch(/Use the saved settings$/)
    expect(resumed.resumeFallbackPrompt, 'Completed-task follow-ups must not silently lose conversation history').toBe(undefined)
    expect(resumed.prompt).not.toMatch(/Do not change project files/)
    expect(store.getTaskExecution(task.id)?.phase, 'Follow-ups do not replan the task').toBe('complete')
    agentProcesses.emit('usage', { taskId: task.id, inputTokens: 3, outputTokens: 2, cachedTokens: 0, totalTokens: 5, costUsd: null })
    agentProcesses.finishTurn(task.id)
    await tick()
    expect(store.getTask(task.id)?.deliveryStatus).toBe('reviewable')
    expect(store.getTask(task.id)?.headCommit, 'Follow-ups refresh the final task diff').not.toBe(finished.headCommit)
    expect(store.getTask(task.id)?.totalTokens).toBe(20)
    expect(store.getTask(task.id)?.baseCommit).toBe(finished.baseCommit)

    // Reproduce a task left mid-finalization when Anvil closes itself.
    store.addTask({ ...finished, id: 'interrupted', status: 'cancelled', deliveryStatus: 'finalizing', error: 'Task cancelled.' })
    store.saveTaskExecution({ ...new TaskIssues(store).initialize('interrupted', testHome), phase: 'blocked' })
    const recovered = new Store(databasePath, options)
    expect(recovered.getTask('interrupted')?.status).toBe('pending')
    expect(recovered.getTask('interrupted')?.deliveryStatus).toBe('agent_failed')
    recovered.close()
    gitDelivery.checkoutBranch = originalReopen
    await steer('interrupted', 'Fix the already running error')
    expect(agentProcesses.starts.at(-1).resumeSessionId).toBe(finished.sessionId)
    expect(agentProcesses.starts.at(-1).resumeFallbackPrompt).toMatch(/Original task/)
    expect(agentProcesses.starts.at(-1).resumeFallbackPrompt).toMatch(/Fix the already running error/)
    agentProcesses.finishTurn('interrupted')
    await tick()

    store.addTask({ ...finished, id: 'unfinished', prompt: 'Preserve current issue', status: 'pending', deliveryStatus: 'agent_failed' })
    const unfinished = new TaskIssues(store).initialize('unfinished', testHome)
    const tracker = store.issueTracker('project')
    const [completed, interrupted] = tracker.createMany(['completed', 'interrupted'].map((key) => ({
      key, parentId: unfinished.parentIssueId, title: key, description: key, checklist: ['Check'], validation: 'Test'
    })))
    tracker.start(completed.id)
    tracker.submitForReview(completed.id, { checklist: [true], evidence: 'Validated' })
    tracker.approve(completed.id)
    tracker.start(interrupted.id)
    store.saveTaskExecution({
      ...unfinished, phase: 'blocked', issueIds: [completed.id, interrupted.id], currentIssueId: interrupted.id
    })
    await steer('unfinished', 'Keep going')
    const recovery = agentProcesses.starts.at(-1)
    expect(recovery.resumeSessionId, 'Always attempt the original conversation first').toBe(finished.sessionId)
    expect(recovery.resumeFallbackPrompt).toMatch(/Original task: Preserve current issue/)
    expect(recovery.resumeFallbackPrompt).toContain(`Resume issue ${interrupted.id}`)
    expect(recovery.resumeFallbackPrompt).toContain(`${completed.id}, ${interrupted.id}`)
    expect(recovery.resumeFallbackPrompt).toMatch(/do not repeat completed issues/)
    expect(recovery.resumeFallbackPrompt).toMatch(/Keep its existing plan and branch/)
    expect(recovery.resumeFallbackPrompt).toMatch(/Developer message: Keep going/)
    expect(store.getTask('unfinished')?.baseCommit).toBe(finished.baseCommit)
    agentProcesses.emit('session', { taskId: 'unfinished', sessionId: 'replacement-session' })
    expect(store.getTask('unfinished')?.sessionId, 'A replacement session becomes the next resume handle').toBe('replacement-session')
    agentProcesses.active.delete('unfinished')

    store.addTask({ ...finished, id: 'deleted' })
    store.saveTaskExecution({ ...new TaskIssues(store).initialize('deleted', testHome), phase: 'complete' })
    const startsBeforeDeletion = agentProcesses.starts.length
    const deletedSend = trackReopen(steer('deleted'))
    call('tasks:delete', 'deleted')
    releaseReopen!()
    await expect(deletedSend).rejects.toThrow(/Task was deleted/)
    expect(agentProcesses.starts.length).toBe(startsBeforeDeletion)

    gitDelivery.checkoutBranch = async () => { throw new Error('Reopen failed') }
    await expect(steer(task.id)).rejects.toThrow(/Reopen failed/)
    expect(store.getTask(task.id)?.status).toBe('succeeded')
    gitDelivery.checkoutBranch = originalReopen
    const originalStart = agentProcesses.start.bind(agentProcesses)
    agentProcesses.start = () => { throw new Error('Executor unavailable') }
    await expect(steer(task.id)).rejects.toThrow(/Executor unavailable/)
    expect(store.getTask(task.id)?.status, 'A failed start restores the finished task').toBe('succeeded')
    agentProcesses.start = originalStart

    store.addTask({ ...finished, id: 'unmanaged', branchName: undefined, baseCommit: undefined, deliveryStatus: 'unavailable' })
    store.saveTaskExecution({ ...new TaskIssues(store).initialize('unmanaged', testHome), phase: 'complete' })
    await steer('unmanaged', 'Continue without Git')
    const unmanagedPrompt = agentProcesses.starts.at(-1).prompt
    expect(unmanagedPrompt).toMatch(/Continue without Git$/)
    expect(unmanagedPrompt).toContain('Keep long-running commands observable')
    expect(unmanagedPrompt).toContain('Use targeted tests and checks')
    expect(unmanagedPrompt).not.toContain('Use Git normally')
    expect(agentProcesses.starts.at(-1).resumeSessionId).toBe(finished.sessionId)
    agentProcesses.finishTurn('unmanaged')
    await tick()
    expect(store.getTask('unmanaged')?.deliveryStatus).toBe('unavailable')

    store.addTask({ ...finished, id: 'settled', prompt: 'Settled task', settledAt: 1 })
    await expect(steer('settled')).rejects.toThrow(/settled and cannot receive new instructions/)
    expect(store.getTask('settled')?.status, 'A settled task stays closed').toBe('succeeded')
  }
  store.close()
  const restarted = new Store(databasePath, options)
  try {
    const task = restarted.getTasks().find((task) => task.prompt === 'Original task' && task.id !== 'unsupported' && task.id !== 'unmanaged')!
    expect(task.model).toBe('original-model')
    expect(task.sessionId).toBe('newest-session')
    expect(restarted.getTaskExecution(task.id)?.reasoningEffort, 'Reasoning settings survive restart').toBe('high')
  } finally {
    restarted.close()
  }
})
