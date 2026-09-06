import assert from 'node:assert/strict'
import { join } from 'node:path'
import { openTracker } from 'valence'
import { Store } from '../src/main/store'
import { registerIpc } from '../src/main/ipc'
import { taskState } from './task-state'
import { handlers, testHome, AgentProcessManager, GitDeliveryManager } from './issue-tracker-doubles'

async function main(): Promise<void> {
  const options = { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') }
  const database = join(testHome, '.anvil-composer/anvil.db')
  const store = new Store(database, options)
  store.addProject({ id: 'project', name: 'Test', path: testHome, createdAt: Date.now(), monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
  const { agentProcesses: processes } = registerIpc(() => null)
  const agentProcesses = processes as unknown as AgentProcessManager
  const call = (name: string, input: unknown): any => handlers.get(name)!(null, input)
  const tick = async (): Promise<void> => { for (let index = 0; index < 8; index++) await new Promise((resolve) => setImmediate(resolve)) }
  const issue = { key: 'first', title: 'Small change', description: 'One behavior', labels: ['backend'], priority: 'medium', dependencies: [], checklist: ['Change behavior', 'Verify result'], validation: 'Run focused test' }
  const start = async (prompt: string, agentId = 'codex'): Promise<string> => {
    const task = await call('tasks:start', { projectId: 'project', agentId, prompt })
    await tick()
    return task.id
  }
  const complete = async (taskId: string): Promise<void> => {
    const currentIssueId = store.getTaskExecution(taskId)!.currentIssueId
    agentProcesses.result(taskId, { id: currentIssueId, status: 'complete', checklist: [true, true], evidence: 'Focused tests passed' })
    await tick()
  }

  const taskId = await start('Build a feature')
  assert.match(agentProcesses.starts[0].prompt, /Do not change files/)
  assert.equal(handlers.has('board:review'), false)
  agentProcesses.result(taskId, { items: [
    { ...issue, key: 'dependent', priority: 'urgent', dependencies: ['first'] },
    { ...issue, priority: 'low' },
    { ...issue, key: 'independent', priority: 'high' }
  ] })
  await tick()
  const [dependent, prerequisite, independent] = taskState(store, taskId)!.items
  assert.match(prerequisite.id, /^[0-9a-f]{16}$/)
  assert.deepEqual(dependent.dependencies, [prerequisite.id])
  assert.deepEqual(prerequisite.labels, ['backend'])
  assert.equal(independent.status, 'working', 'Valence chooses priority among ready task issues')
  assert.equal(dependent.status, 'queued', 'Dependencies override priority')
  assert.equal('items' in store.getTaskExecution(taskId)!, false, 'Anvil persists IDs, not duplicate issue records')
  assert.throws(() => call('tasks:approve', taskId), /not finished/)
  await assert.rejects(call('comments:send', taskId), /not finished/)
  agentProcesses.emit('usage', { taskId, inputTokens: 5, outputTokens: 2, cachedTokens: 0, totalTokens: 7, costUsd: null })
  agentProcesses.emit('usage', { taskId, inputTokens: 5, outputTokens: 2, cachedTokens: 0, totalTokens: 7, costUsd: null })
  assert.equal(store.getTask(taskId)?.totalTokens, 7, 'Repeated cumulative usage snapshots must not be added twice')
  await complete(taskId)
  assert.equal(store.getTaskExecution(taskId)?.currentIssueId, prerequisite.id)
  assert.equal(store.getTask(taskId)?.status, 'running')
  assert.equal(GitDeliveryManager.head, 0, 'Git delivery waits until all issues finish')
  agentProcesses.emit('usage', { taskId, inputTokens: 3, outputTokens: 1, cachedTokens: 0, totalTokens: 4, costUsd: null })
  await complete(taskId)
  assert.equal(store.getTaskExecution(taskId)?.currentIssueId, dependent.id)
  await complete(taskId)
  assert.equal(store.getTaskExecution(taskId)?.phase, 'complete')
  assert.equal(store.getTask(taskId)?.deliveryStatus, 'reviewable')
  assert.equal(store.getTask(taskId)?.totalTokens, 11)
  assert.equal((await call('tasks:diff', taskId)).patch, 'base..commit-1')
  call('tasks:approve', taskId)
  assert.equal(store.getTask(taskId)?.deliveryStatus, 'approved')

  const tracker = openTracker(testHome)
  const helloId = await start('hello')
  const startsAfterHello = agentProcesses.starts.length
  const issuesBeforeHello = tracker.list().length
  assert.match(agentProcesses.starts.at(-1).prompt, /greetings/)
  agentProcesses.result(helloId, { items: [], noChanges: true })
  await tick()
  assert.equal(store.getTask(helloId)?.status, 'succeeded')
  assert.equal(store.getTaskExecution(helloId)?.phase, 'complete')
  assert.equal(agentProcesses.starts.length, startsAfterHello, 'A greeting must not launch an implementation turn')
  assert.equal(tracker.list().length, issuesBeforeHello, 'A no-work response creates no issues')

  for (const items of [
    [], Array(51).fill(issue), [issue, issue], [issue, { ...issue, key: 'bad', checklist: [] }],
    [{ ...issue, validation: '' }], [{ ...issue, labels: null }], [{ ...issue, priority: 'invalid' }],
    [{ ...issue, status: 'complete' }], [{ ...issue, dependencies: ['missing'] }],
    [{ ...issue, dependencies: ['first'] }],
    [{ ...issue, dependencies: ['second'] }, { ...issue, key: 'second', dependencies: ['first'] }]
  ]) {
    const count = tracker.list().length
    const invalidId = await start('Invalid plan')
    agentProcesses.result(invalidId, { items })
    await tick()
    assert.equal(store.getTask(invalidId)?.status, 'failed')
    assert.equal(store.getTaskExecution(invalidId)?.phase, 'blocked')
    assert.equal(tracker.list().length, count, 'Malformed plans must not leave partial Valence issues')
  }
  const maximumId = await start('Fifty issues')
  agentProcesses.result(maximumId, { items: Array.from({ length: 50 }, (_, index) => ({ ...issue, key: String(index) })) })
  await tick()
  assert.equal(store.getTaskExecution(maximumId)?.issueIds.length, 50)
  call('tasks:cancel', maximumId)
  await tick()

  for (const completion of [
    { checklist: [true, false], evidence: 'Failed' },
    { checklist: [true], evidence: 'Missing item' },
    { checklist: [true, true], evidence: '' },
    { checklist: [true, true], evidence: 'Wrong issue', id: 'other' }
  ]) {
    const failedId = await start('Validation failure')
    agentProcesses.result(failedId, { items: [issue, { ...issue, key: 'second' }] })
    await tick()
    const currentId = store.getTaskExecution(failedId)!.currentIssueId!
    const before = agentProcesses.starts.length
    agentProcesses.result(failedId, { id: currentId, status: 'complete', ...completion })
    await tick()
    assert.equal(agentProcesses.starts.length, before)
    assert.equal(tracker.get(currentId).status, 'blocked')
    assert.equal(store.getTask(failedId)?.status, 'failed')
  }

  const betweenId = await start('Cancel between issues')
  agentProcesses.result(betweenId, { items: [issue, { ...issue, key: 'second' }] })
  await tick()
  const firstBetween = store.getTaskExecution(betweenId)!.currentIssueId
  const startsBeforeCancel = agentProcesses.starts.length
  agentProcesses.result(betweenId, { id: firstBetween, status: 'complete', checklist: [true, true], evidence: 'Passed' })
  assert.equal(call('tasks:cancel', betweenId), true)
  await tick()
  assert.equal(agentProcesses.starts.length, startsBeforeCancel)
  assert.equal(store.getTask(betweenId)?.status, 'cancelled')

  GitDeliveryManager.failFinalize = true
  const deliveryId = await start('Delivery failure')
  agentProcesses.result(deliveryId, { items: [issue] })
  await tick()
  await complete(deliveryId)
  assert.equal(store.getTask(deliveryId)?.deliveryStatus, 'failed')
  assert.throws(() => call('tasks:approve', deliveryId), /not awaiting review/)
  GitDeliveryManager.failFinalize = false
  GitDeliveryManager.repository = false
  for (const agentId of ['opencode', 'codex']) {
    const serverId = await start('Server task result without Git', agentId)
    const serverResult = async (payload: unknown): Promise<void> => {
      agentProcesses.active.delete(serverId)
      agentProcesses.emit('exit', { taskId: serverId, code: 0, cancelled: false,
        result: { taskId: serverId, status: 'succeeded', output: `<task-result>${JSON.stringify(payload)}</task-result>`, changedFiles: [] } })
      await tick()
    }
    await serverResult({ items: [issue] })
    const currentId = store.getTaskExecution(serverId)!.currentIssueId!
    assert.equal(agentProcesses.starts.at(-1).issueId, currentId)
    await serverResult({ id: currentId, status: 'complete', checklist: [true, true], evidence: 'Server validation passed' })
    assert.equal(tracker.get(currentId).evidence, 'Server validation passed')
    assert.equal(store.getTask(serverId)?.status, 'succeeded')
    assert.equal(store.getTask(serverId)?.deliveryStatus, 'unavailable')
  }
  tracker.close()
  store.close()
  console.log('Task execution tests passed: Valence plans, dependency/priority claims, validation, cancellation, protocol results, and final delivery.')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
