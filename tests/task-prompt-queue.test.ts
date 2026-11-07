import { rendererEvent, rendererIpc } from './renderer-fixture'
import { expect, test } from 'vitest'
import { onTestCleanup } from './test-cleanup'
import { join } from 'node:path'
import type { AgentProcessManager as RealAgentProcessManager } from '../apps/server/src/agents/process-manager'
import type { GitDeliveryManager as RealGitDeliveryManager } from '../apps/server/src/git'
import { registerTaskHandlers } from '../apps/server/src/handlers/tasks'
import { STEER_FALLBACK_NOTICE, registerSteeringHandlers } from '../apps/server/src/handlers/steering'
import { createTaskMemory } from '../apps/server/src/memory/task-memory'
import { createTaskCompletion } from '../apps/server/src/tasks/completion'
import { registerTaskEvents } from '../apps/server/src/tasks/events'
import { registerTaskExecution } from '../apps/server/src/tasks/task-execution'
import { Store } from '../apps/server/src/store'
import type { Task } from '@anvil/protocol/types'
import { AgentProcessManager, GitDeliveryManager, handlers, testHome } from './issue-tracker-doubles'

test('queues prompts while a task runs and drains them in order after each turn', async () => {
  const databasePath = join(testHome, 'queue.json')
  const options = { migrationsFolder: join(process.cwd(), 'apps/server/src/db/migrations') }
  const store = new Store(databasePath, options)
  onTestCleanup(() => store.close())
  store.addProject({
    id: 'project', name: 'Project', path: testHome, createdAt: 0,
    monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, shipPushes: false, gitPlatform: 'github'
  })
  const agentProcesses = new AgentProcessManager()
  onTestCleanup(async () => {
    await new Promise<void>((resolve) => setImmediate(resolve))
    await agentProcesses.close()
  })
  const gitDelivery = new GitDeliveryManager()
  const published: Task[] = []
  const context = {
    store, agentProcesses: agentProcesses as unknown as RealAgentProcessManager,
    gitDelivery: gitDelivery as unknown as RealGitDeliveryManager,
    send: (channel: string, payload: unknown) => { if (channel === 'task:updated') published.push(payload as Task) }
  }
  const taskEvents = registerTaskEvents(context)
  const memory = createTaskMemory(context)
  const execution = registerTaskExecution({ ...context, recordSystemEvent: taskEvents.recordSystemEvent }, createTaskCompletion(context, taskEvents.recordSystemEvent, memory))
  registerTaskHandlers(rendererIpc, { ...context, ...taskEvents, ...execution, promptWithProjectMemory: memory.promptWithProjectMemory })
  registerSteeringHandlers(rendererIpc, { ...context, ...taskEvents, ...execution })
  const call = (name: string, input?: unknown): any => handlers.get(name)!(rendererEvent, input)
  const tick = async (): Promise<void> => {
    for (let index = 0; index < 12; index++) await new Promise((resolve) => setImmediate(resolve))
  }
  const queue = (taskId: string) => store.getTask(taskId)?.promptQueue ?? []
  const queued = (taskId: string): string[] => queue(taskId).map((item) => item.message)
  const finish = async (taskId: string): Promise<void> => {
    agentProcesses.finishTurn(taskId)
    await tick()
  }

  expect(() => call('tasks:steer', { taskId: 'task', message: 'x', mode: 'later' })).toThrow(/Invalid IPC request/)
  expect(() => call('tasks:queue:edit', { taskId: 'task', id: 'item', message: '  ' })).toThrow(/Invalid IPC request/)

  const task: Task = await call('tasks:start', { projectId: 'project', agentId: 'codex', prompt: 'Original task' })
  await tick()
  agentProcesses.emit('session', { taskId: task.id, sessionId: 'session' })

  await call('tasks:steer', { taskId: task.id, message: ' First ', mode: 'queue' })
  expect(queued(task.id)).toEqual(['First'])
  expect(store.readEvents(task.id).some((event) => event.text === 'Queued for after this turn:\nFirst')).toBe(true)
  expect(agentProcesses.steering).toEqual([])
  expect(published.at(-1)?.promptQueue?.map((item) => item.message), 'Queue changes are broadcast').toEqual(['First'])

  await call('tasks:steer', { taskId: task.id, message: 'Live', mode: 'steer' })
  expect(agentProcesses.steering.map((input) => input.message)).toEqual(['Live'])
  expect(queued(task.id)).toEqual(['First'])

  const originalSteer = agentProcesses.steer.bind(agentProcesses)
  agentProcesses.steer = async () => { throw new Error('Agent rejected steering') }
  await call('tasks:steer', { taskId: task.id, message: 'Second' })
  expect(queued(task.id)).toEqual(['First', 'Second'])
  expect(store.readEvents(task.id).filter((event) => event.text === STEER_FALLBACK_NOTICE)).toHaveLength(1)

  await call('tasks:steer', { taskId: task.id, message: 'Third', mode: 'queue' })
  await call('tasks:steer', { taskId: task.id, message: 'Drop', mode: 'queue' })
  const [, second, third, drop] = queue(task.id)
  call('tasks:queue:remove', { taskId: task.id, id: drop.id })
  call('tasks:queue:edit', { taskId: task.id, id: third.id, message: ' Third edited ' })
  expect(queued(task.id)).toEqual(['First', 'Second', 'Third edited'])
  expect(() => call('tasks:queue:edit', { taskId: task.id, id: drop.id, message: 'Gone' })).toThrow(/already sent or removed/)

  await expect(call('tasks:queue:steer', { taskId: task.id, id: second.id })).rejects.toThrow(/Agent rejected/)
  expect(queued(task.id), 'A failed steer-now keeps the queue position').toEqual(['First', 'Second', 'Third edited'])
  agentProcesses.steer = originalSteer

  store.addComment({ id: 'note', taskId: task.id, body: 'Rename this helper', file: 'a.ts', side: 'additions', lineNumber: 1, createdAt: 0, sentAt: null })
  await call('tasks:queue:steer', { taskId: task.id, id: second.id })
  expect(agentProcesses.steering.at(-1)?.message).toContain('Second')
  expect(agentProcesses.steering.at(-1)?.message).toContain('Rename this helper')
  expect(store.getComments(task.id)[0].sentAt).not.toBeNull()
  expect(queued(task.id)).toEqual(['First', 'Third edited'])

  const startsBeforeDrain = agentProcesses.starts.length
  await finish(task.id)
  expect(agentProcesses.starts).toHaveLength(startsBeforeDrain + 1)
  expect(agentProcesses.starts.at(-1).taskId).toBe(task.id)
  expect(agentProcesses.starts.at(-1).prompt).toContain('First')
  expect(agentProcesses.starts.at(-1).prompt, 'Notes are attached exactly once').not.toContain('Rename this helper')
  expect(store.getTask(task.id)?.status).toBe('running')
  expect(queued(task.id)).toEqual(['Third edited'])
  expect(store.readEvents(task.id).some((event) => event.text === 'You (from queue):\nFirst')).toBe(true)

  await finish(task.id)
  expect(agentProcesses.starts).toHaveLength(startsBeforeDrain + 2)
  expect(agentProcesses.starts.at(-1).prompt).toContain('Third edited')
  expect(queue(task.id)).toEqual([])

  await finish(task.id)
  expect(agentProcesses.starts).toHaveLength(startsBeforeDrain + 2)
  expect(store.getTask(task.id)?.status).toBe('succeeded')

  const restored = new Store(databasePath, options)
  try {
    restored.selectWorkspace(task.workspaceId)
    restored.updateTask(task.id, { promptQueue: [{ id: 'persisted', message: 'Persisted', queuedAt: 1 }] })
  } finally {
    restored.close()
  }
  const reopened = new Store(databasePath, options)
  try {
    expect(reopened.getTask(task.id)?.promptQueue).toEqual([{ id: 'persisted', message: 'Persisted', queuedAt: 1 }])
    reopened.updateTask(task.id, { promptQueue: [] })
  } finally {
    reopened.close()
  }

  await call('tasks:steer', { taskId: task.id, message: 'Resume again' })
  expect(store.getTask(task.id)?.status).toBe('running')
  await call('tasks:steer', { taskId: task.id, message: 'After cancel', mode: 'queue' })
  const startsBeforeCancel = agentProcesses.starts.length
  await call('tasks:cancel', task.id)
  await tick()
  expect(store.getTask(task.id)?.status).toBe('cancelled')
  expect(agentProcesses.starts, 'Cancelled tasks do not drain their queue').toHaveLength(startsBeforeCancel)
  expect(queued(task.id)).toEqual(['After cancel'])

  await call('tasks:queue:steer', { taskId: task.id, id: queue(task.id)[0].id })
  expect(agentProcesses.starts).toHaveLength(startsBeforeCancel + 1)
  expect(agentProcesses.starts.at(-1).prompt).toContain('After cancel')
  expect(queue(task.id)).toEqual([])
  await finish(task.id)

  store.updateTask(task.id, { settledAt: 1 })
  await expect(call('tasks:steer', { taskId: task.id, message: 'Archived', mode: 'queue' })).rejects.toThrow(/archived/)
  expect(queue(task.id)).toEqual([])
})
