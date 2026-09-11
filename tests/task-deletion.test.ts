import { rendererEvent } from './renderer-fixture'
import { expect, test } from 'vitest'
import { onTestCleanup } from './test-cleanup'
import { join } from 'node:path'
import { Store } from '../src/server/store'
import { registerTestIpc } from './test-ipc'
import { handlers, testHome, AgentProcessManager, GitDeliveryManager } from './issue-tracker-doubles'
import type { Task, TaskComment } from '../src/shared/types'

test('deletes finished, active and queued tasks without resurrecting persisted state', async () => {
  const options = { migrationsFolder: join(process.cwd(), 'src/server/db/migrations') }
  const database = join(testHome, '.anvil-composer/anvil.db')
  const store = new Store(database, options)
  store.addProject({
    id: 'project', name: 'Test', path: testHome, createdAt: Date.now(),
    monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github'
  })
  const { agentProcesses: registeredAgentProcesses } = registerTestIpc()
  const agentProcesses = registeredAgentProcesses as unknown as AgentProcessManager
  const call = (name: string, input: unknown): any => handlers.get(name)!(rendererEvent, input)
  const tick = async (): Promise<void> => {
    for (let index = 0; index < 8; index++) await new Promise((resolve) => setImmediate(resolve))
  }
  const issue = {
    key: 'first', title: 'Change', description: 'One behavior', labels: [], priority: 'medium' as const,
    dependencies: [], checklist: ['Verify'], validation: 'Run test'
  }
  const start = async (): Promise<Task> => {
    const task = await call('tasks:start', { projectId: 'project', agentId: 'codex', prompt: 'Delete test' })
    await tick()
    return task
  }
  const complete = async (): Promise<Task> => {
    const task = await start()
    agentProcesses.plan(task.id, [issue])
    await tick()
    agentProcesses.completeIssue(task.id, store.getTaskExecution(task.id)!.currentIssueId!, {
      checklist: [true], evidence: 'Test passed'
    })
    await tick()
    return store.getTask(task.id)!
  }
  const assertDeleted = (taskId: string): void => {
    expect(store.issueTracker('project').listParents().some((parent) => parent.anvilTaskId === taskId)).toBe(false)
    expect(store.getTask(taskId)).toBe(undefined)
    expect(store.getTaskExecution(taskId)).toBe(undefined)
    expect(store.readEvents(taskId)).toStrictEqual([])
    expect(store.getComments(taskId)).toStrictEqual([])
    expect(!store.getTasks().some((task) => task.id === taskId)).toBeTruthy()
  }

  const kept = await complete()
  const finished = await complete()
  const comment: TaskComment = {
    id: 'comment', taskId: finished.id, file: 'test.ts', side: 'additions',
    lineNumber: 1, body: 'Review', createdAt: Date.now(), sentAt: null
  }
  store.addComment(comment)
  expect(store.readEvents(finished.id).length).toBeTruthy()
  expect(store.getTaskExecution(finished.id)!.issueIds.length).toBeTruthy()
  expect(store.getComments(finished.id).length).toBe(1)
  call('tasks:delete', finished.id)
  assertDeleted(finished.id)
  expect(store.getTask(kept.id)).toBeTruthy()
  expect(store.getTaskExecution(kept.id)).toBeTruthy()
  expect(store.readEvents(kept.id).length).toBeTruthy()
  expect(store.getProjects().length).toBe(1)
  call('tasks:delete', finished.id) // Retrying a deletion is harmless.
  expect(() => call('tasks:delete', null)).toThrow(/Invalid IPC request/)

  const active = await start()
  agentProcesses.plan(active.id, [issue, { ...issue, key: 'second' }])
  await tick()
  expect(agentProcesses.isRunning(active.id)).toBeTruthy()
  const startsBeforeDelete = agentProcesses.starts.length
  call('tasks:delete', active.id)
  expect(agentProcesses.isRunning(active.id)).toBe(false)
  // A real child process can still flush buffered output and exit after SIGTERM.
  agentProcesses.finishTurn(active.id, 'Late buffered output')
  agentProcesses.emit('usage', { taskId: active.id, inputTokens: 1, outputTokens: 1, cachedTokens: 0, totalTokens: 2, costUsd: null })
  await tick()
  assertDeleted(active.id)
  expect(agentProcesses.starts.length).toBe(startsBeforeDelete)

  const between = await start()
  agentProcesses.plan(between.id, [issue])
  const startsBeforeQueuedIssue = agentProcesses.starts.length
  call('tasks:delete', between.id)
  await tick()
  assertDeleted(between.id)
  expect(agentProcesses.starts.length, 'A queued issue must not start after deletion').toBe(startsBeforeQueuedIssue)

  // Deletion while Git delivery is awaiting I/O must not restore tracker state.
  const finalizing = await start()
  agentProcesses.plan(finalizing.id, [issue])
  await tick()
  const originalFinalize = GitDeliveryManager.prototype.finalizeBranch
  let finishDelivery: (() => void) | undefined
  onTestCleanup(async () => {
    finishDelivery?.()
    await tick()
  })
  GitDeliveryManager.prototype.finalizeBranch = async function () {
    await new Promise<void>((resolve) => { finishDelivery = resolve })
    throw new Error('Late delivery error')
  }
  agentProcesses.completeIssue(finalizing.id, store.getTaskExecution(finalizing.id)!.currentIssueId!, {
    checklist: [true], evidence: 'Passed'
  })
  call('tasks:delete', finalizing.id)
  finishDelivery!()
  await tick()
  assertDeleted(finalizing.id)
  GitDeliveryManager.prototype.finalizeBranch = originalFinalize

  // A follow-up must not start if the task is deleted while checking out its branch.
  const followUp = await complete()
  const originalReopen = GitDeliveryManager.prototype.checkoutBranch
  let finishReopen: (() => void) | undefined
  onTestCleanup(async () => {
    finishReopen?.()
    await tick()
  })
  GitDeliveryManager.prototype.checkoutBranch = async function () {
    await new Promise<void>((resolve) => { finishReopen = resolve })
    return this.prepareBranch()
  }
  const rebase = call('tasks:rebase-agent', followUp.id)
  call('tasks:delete', followUp.id)
  finishReopen!()
  await expect(rebase).rejects.toThrow(/deleted/)
  await tick()
  assertDeleted(followUp.id)
  expect(agentProcesses.isRunning(followUp.id)).toBe(false)
  GitDeliveryManager.prototype.checkoutBranch = originalReopen

  const restarted = new Store(database, options)
  expect(restarted.getTask(finished.id)).toBe(undefined)
  expect(restarted.getTaskExecution(finished.id)).toBe(undefined)
  expect(restarted.getComments(finished.id)).toStrictEqual([])
  expect(restarted.readEvents(finished.id)).toStrictEqual([])
  expect(restarted.getTask(kept.id)).toBeTruthy()
  restarted.close()
  store.close()
})
