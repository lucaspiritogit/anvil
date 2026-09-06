import assert from 'node:assert/strict'
import { join } from 'node:path'
import { Store } from '../src/main/store'
import { registerIpc } from '../src/main/ipc'
import { handlers, testHome, AgentProcessManager, GitDeliveryManager } from './issue-tracker-doubles'
import type { Task, TaskComment } from '../src/shared/types'

async function main(): Promise<void> {
  const options = { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') }
  const database = join(testHome, '.anvil-composer/anvil.db')
  const store = new Store(database, options)
  store.addProject({
    id: 'project', name: 'Test', path: testHome, createdAt: Date.now(),
    monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github'
  })
  const { agentProcesses: registeredAgentProcesses } = registerIpc(() => null)
  const agentProcesses = registeredAgentProcesses as unknown as AgentProcessManager
  const call = (name: string, input: unknown): any => handlers.get(name)!(null, input)
  const tick = async (): Promise<void> => {
    for (let index = 0; index < 8; index++) await new Promise((resolve) => setImmediate(resolve))
  }
  const issue = {
    key: 'first', title: 'Change', description: 'One behavior', labels: [], priority: 'medium',
    dependencies: [], status: 'queued', checklist: ['Verify'], validation: 'Run test'
  }
  const start = async (): Promise<Task> => {
    const task = await call('tasks:start', { projectId: 'project', agentId: 'codex', prompt: 'Delete test' })
    await tick()
    return task
  }
  const complete = async (): Promise<Task> => {
    const task = await start()
    agentProcesses.result(task.id, { items: [issue] })
    await tick()
    agentProcesses.result(task.id, {
      id: store.getIssueTracker(task.id)!.items[0].id,
      status: 'complete', checklist: [true], evidence: 'Test passed'
    })
    await tick()
    return store.getTask(task.id)!
  }
  const assertDeleted = (taskId: string): void => {
    assert.equal(store.getTask(taskId), undefined)
    assert.equal(store.getIssueTracker(taskId), undefined)
    assert.deepEqual(store.readEvents(taskId), [])
    assert.deepEqual(store.getComments(taskId), [])
    assert.ok(!store.getTasks().some((task) => task.id === taskId))
  }

  const kept = await complete()
  const finished = await complete()
  const comment: TaskComment = {
    id: 'comment', taskId: finished.id, file: 'test.ts', side: 'additions',
    lineNumber: 1, body: 'Review', createdAt: Date.now(), sentAt: null
  }
  store.addComment(comment)
  assert.ok(store.readEvents(finished.id).length)
  assert.ok(store.getIssueTracker(finished.id)!.items.length)
  assert.equal(store.getComments(finished.id).length, 1)
  call('tasks:delete', finished.id)
  assertDeleted(finished.id)
  assert.ok(store.getTask(kept.id))
  assert.ok(store.getIssueTracker(kept.id))
  assert.ok(store.readEvents(kept.id).length)
  assert.equal(store.getProjects().length, 1)
  call('tasks:delete', finished.id) // Retrying a deletion is harmless.
  assert.throws(() => call('tasks:delete', null), /task ID/)

  const active = await start()
  agentProcesses.result(active.id, { items: [issue, { ...issue, key: 'second' }] })
  await tick()
  assert.ok(agentProcesses.isRunning(active.id))
  const startsBeforeDelete = agentProcesses.starts.length
  call('tasks:delete', active.id)
  assert.equal(agentProcesses.isRunning(active.id), false)
  // A real child process can still flush buffered output and exit after SIGTERM.
  agentProcesses.result(active.id, { items: [issue] })
  agentProcesses.emit('usage', { taskId: active.id, inputTokens: 1, outputTokens: 1, cachedTokens: 0, totalTokens: 2, costUsd: null })
  await tick()
  assertDeleted(active.id)
  assert.equal(agentProcesses.starts.length, startsBeforeDelete)

  const between = await start()
  agentProcesses.result(between.id, { items: [issue] })
  const startsBeforeQueuedIssue = agentProcesses.starts.length
  call('tasks:delete', between.id)
  await tick()
  assertDeleted(between.id)
  assert.equal(agentProcesses.starts.length, startsBeforeQueuedIssue, 'A queued issue must not start after deletion')

  // Deletion while Git delivery is awaiting I/O must not restore tracker state.
  const finalizing = await start()
  agentProcesses.result(finalizing.id, { items: [issue] })
  await tick()
  const originalFinalize = GitDeliveryManager.prototype.finalize
  let finishDelivery!: () => void
  GitDeliveryManager.prototype.finalize = async function () {
    await new Promise<void>((resolve) => { finishDelivery = resolve })
    throw new Error('Late delivery error')
  }
  agentProcesses.result(finalizing.id, {
    id: store.getIssueTracker(finalizing.id)!.items[0].id,
    status: 'complete', checklist: [true], evidence: 'Passed'
  })
  call('tasks:delete', finalizing.id)
  finishDelivery()
  await tick()
  assertDeleted(finalizing.id)
  GitDeliveryManager.prototype.finalize = originalFinalize

  // A follow-up must not start if the task is deleted while reopening its worktree.
  const followUp = await complete()
  const originalReopen = GitDeliveryManager.prototype.reopen
  let finishReopen!: () => void
  GitDeliveryManager.prototype.reopen = async function () {
    await new Promise<void>((resolve) => { finishReopen = resolve })
    return this.prepare()
  }
  const rebase = call('tasks:rebase-agent', followUp.id)
  call('tasks:delete', followUp.id)
  finishReopen()
  await assert.rejects(rebase, /deleted/)
  await tick()
  assertDeleted(followUp.id)
  assert.equal(agentProcesses.isRunning(followUp.id), false)
  GitDeliveryManager.prototype.reopen = originalReopen

  const restarted = new Store(database, options)
  assert.equal(restarted.getTask(finished.id), undefined)
  assert.equal(restarted.getIssueTracker(finished.id), undefined)
  assert.deepEqual(restarted.getComments(finished.id), [])
  assert.deepEqual(restarted.readEvents(finished.id), [])
  assert.ok(restarted.getTask(kept.id))
  restarted.close()
  store.close()
  console.log('Task deletion tests passed: SQLite cascades, cancellation, late callbacks, queued issues, and restart persistence.')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
