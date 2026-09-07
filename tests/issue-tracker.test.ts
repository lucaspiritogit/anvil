import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { openTracker, type BatchIssue } from 'valence'
import { Store } from '../src/main/store'
import { registerIpc } from '../src/main/ipc'
import { taskIssueLabel } from '../src/shared/valence'
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
  const issue: BatchIssue = { key: 'first', title: 'Small change', description: 'One behavior', labels: ['backend'], priority: 'medium', dependencies: [], checklist: ['Change behavior', 'Verify result'], validation: 'Run focused test' }
  const start = async (prompt: string, agentId = 'codex'): Promise<string> => {
    const task = await call('tasks:start', { projectId: 'project', agentId, prompt })
    await tick()
    return task.id
  }
  const complete = async (taskId: string): Promise<void> => {
    agentProcesses.completeIssue(taskId, store.getTaskExecution(taskId)!.currentIssueId!, {
      checklist: [true, true], evidence: 'Focused tests passed'
    })
    await tick()
  }

  const taskId = await start('Build a feature')
  const tracker = openTracker(testHome)
  assert.equal(tracker.databasePath, join(homedir(), '.config', 'valence', basename(testHome), 'sqlite.db'))
  assert.equal(existsSync(join(testHome, '.valence')), false, 'Starting a task must not create project-local storage')
  assert.match(agentProcesses.starts[0].prompt, /Do not change project files/)
  assert.equal(agentProcesses.starts[0].projectPath, testHome)
  assert.ok(agentProcesses.starts[0].prompt.includes(taskIssueLabel(taskId)))
  assert.equal(handlers.has('board:review'), false)
  const { key: _key, ...fields } = issue
  const unrelated = tracker.create({ ...fields, priority: 'urgent' })
  const otherTaskId = await start('Concurrent plan')
  const [otherIssue] = agentProcesses.createPlan(otherTaskId, [{ ...issue, priority: 'urgent' }])
  agentProcesses.plan(taskId, [
    { ...issue, key: 'dependent', priority: 'urgent', dependencies: ['first'] },
    { ...issue, priority: 'low' },
    { ...issue, key: 'independent', priority: 'high' }
  ])
  await tick()
  const [dependent, prerequisite, independent] = taskState(store, taskId)!.items
  assert.match(prerequisite.id, /^[0-9a-f]{16}$/)
  assert.deepEqual(dependent.dependencies, [prerequisite.id])
  assert.deepEqual(prerequisite.labels, ['backend', taskIssueLabel(taskId)])
  assert.equal(independent.status, 'working', 'Valence chooses priority among ready task issues')
  assert.equal(dependent.status, 'queued', 'Dependencies override priority')
  assert.equal(tracker.get(unrelated.id).status, 'queued')
  assert.equal(tracker.get(otherIssue.id).status, 'queued', 'Do not adopt another concurrent plan')
  agentProcesses.finishTurn(otherTaskId, 'My plan is ready.')
  await tick()
  assert.deepEqual(store.getTaskExecution(otherTaskId)!.issueIds, [otherIssue.id])
  assert.equal(tracker.get(otherIssue.id).status, 'working')
  call('tasks:cancel', otherTaskId)
  await tick()
  const deliveriesBeforeCompletion = GitDeliveryManager.head
  assert.equal('items' in store.getTaskExecution(taskId)!, false, 'Persist IDs, not duplicate issue records')
  assert.throws(() => call('tasks:approve', taskId), /not finished/)
  await assert.rejects(call('comments:send', taskId), /not finished/)
  agentProcesses.emit('usage', { taskId, inputTokens: 5, outputTokens: 2, cachedTokens: 0, totalTokens: 7, costUsd: null })
  agentProcesses.emit('usage', { taskId, inputTokens: 5, outputTokens: 2, cachedTokens: 0, totalTokens: 7, costUsd: null })
  assert.equal(store.getTask(taskId)?.totalTokens, 7)
  await complete(taskId)
  assert.equal(store.getTaskExecution(taskId)?.currentIssueId, prerequisite.id)
  assert.equal(store.getTask(taskId)?.status, 'running')
  assert.equal(GitDeliveryManager.head, deliveriesBeforeCompletion, 'Git delivery waits until all issues finish')
  agentProcesses.emit('usage', { taskId, inputTokens: 3, outputTokens: 1, cachedTokens: 0, totalTokens: 4, costUsd: null })
  await complete(taskId)
  assert.equal(store.getTaskExecution(taskId)?.currentIssueId, dependent.id)
  await complete(taskId)
  assert.equal(store.getTaskExecution(taskId)?.phase, 'complete')
  assert.equal(store.getTask(taskId)?.deliveryStatus, 'reviewable')
  assert.equal(store.getTask(taskId)?.totalTokens, 11)
  assert.equal((await call('tasks:diff', taskId)).patch, `base..commit-${deliveriesBeforeCompletion + 1}`)
  call('tasks:approve', taskId)
  assert.equal(store.getTask(taskId)?.deliveryStatus, 'approved')

  const helloId = await start('hello')
  const startsAfterHello = agentProcesses.starts.length
  const issuesBeforeHello = tracker.list().length
  agentProcesses.finishTurn(helloId, 'Hello!')
  await tick()
  assert.equal(store.getTask(helloId)?.status, 'succeeded')
  assert.equal(store.getTaskExecution(helloId)?.phase, 'complete')
  assert.equal(agentProcesses.starts.length, startsAfterHello)
  assert.equal(tracker.list().length, issuesBeforeHello, 'A no-work response creates no issues')

  const oversizedId = await start('Too many issues')
  agentProcesses.plan(oversizedId, Array.from({ length: 51 }, (_, index) => ({ ...issue, key: String(index) })))
  await tick()
  assert.equal(store.getTask(oversizedId)?.status, 'failed')
  assert.match(store.getTask(oversizedId)!.error!, /at most 50/)
  assert.deepEqual(store.getTaskExecution(oversizedId)!.issueIds, [])
  assert.ok(tracker.list().filter((entry) => entry.labels.includes(taskIssueLabel(oversizedId))).every((entry) => entry.status === 'queued'))
  const maximumId = await start('Fifty issues')
  agentProcesses.plan(maximumId, Array.from({ length: 50 }, (_, index) => ({ ...issue, key: String(index) })))
  await tick()
  assert.equal(store.getTaskExecution(maximumId)?.issueIds.length, 50)
  call('tasks:cancel', maximumId)
  await tick()

  for (const exitCode of [0, 1]) {
    const partialId = await start('Partial planning')
    const [partial] = agentProcesses.createPlan(partialId, [issue])
    if (!exitCode) tracker.block(partial.id)
    agentProcesses.finishTurn(partialId, 'Could not finish planning.', exitCode)
    await tick()
    assert.equal(store.getTask(partialId)?.status, 'failed')
    assert.deepEqual(store.getTaskExecution(partialId)!.issueIds, [])
    assert.equal(tracker.get(partial.id).status, exitCode ? 'queued' : 'blocked', 'Do not claim or mutate partial plans')
  }
  const failedEmptyId = await start('Failed empty planning')
  agentProcesses.finishTurn(failedEmptyId, 'Planning failed.', 1)
  await tick()
  assert.equal(store.getTask(failedEmptyId)?.status, 'failed', 'Failed empty planning is not no-work success')

  for (const completion of [
    { checklist: [true, false], evidence: 'Failed' },
    { checklist: [true], evidence: 'Missing item' },
    { checklist: [true, true], evidence: '' }
  ]) {
    const failedId = await start('Validation failure')
    agentProcesses.plan(failedId, [issue, { ...issue, key: 'second' }])
    await tick()
    const currentId = store.getTaskExecution(failedId)!.currentIssueId!
    const before = agentProcesses.starts.length
    assert.throws(() => tracker.complete(currentId, completion), /checklist|evidence/)
    agentProcesses.finishTurn(failedId, 'Everything is complete!')
    await tick()
    assert.equal(agentProcesses.starts.length, before)
    assert.equal(tracker.get(currentId).status, 'blocked')
    assert.equal(store.getTask(failedId)?.status, 'failed', 'Text cannot substitute for persisted completion')
  }

  const wrongIssueTaskId = await start('Wrong issue completion')
  agentProcesses.plan(wrongIssueTaskId, [issue, { ...issue, key: 'other' }])
  await tick()
  const [assignedId, otherId] = store.getTaskExecution(wrongIssueTaskId)!.issueIds
  tracker.start(otherId)
  tracker.complete(otherId, { checklist: [true, true], evidence: 'Completed the wrong issue' })
  agentProcesses.finishTurn(wrongIssueTaskId, 'Done.')
  await tick()
  assert.equal(store.getTask(wrongIssueTaskId)?.status, 'failed')
  assert.equal(tracker.get(assignedId).status, 'blocked', 'Only assigned issue completion can advance a turn')
  assert.equal(tracker.get(otherId).status, 'complete', 'Do not undo other persisted work')

  const blockedId = await start('Blocked validation')
  agentProcesses.plan(blockedId, [issue])
  await tick()
  const blockedIssueId = store.getTaskExecution(blockedId)!.currentIssueId!
  tracker.block(blockedIssueId)
  const blocker = 'git commit denied index.lock; Vite listen EPERM'
  agentProcesses.finishTurn(blockedId, blocker)
  await tick()
  assert.match(store.getTask(blockedId)!.error!, /blocked in Valence/)
  assert.ok(store.readEvents(blockedId).some((event) => event.text === blocker), 'Plain-text failure details remain visible')
  assert.equal(tracker.get(blockedIssueId).status, 'blocked')

  const betweenId = await start('Cancel between issues')
  agentProcesses.plan(betweenId, [issue, { ...issue, key: 'second' }])
  await tick()
  const startsBeforeCancel = agentProcesses.starts.length
  agentProcesses.completeIssue(betweenId, store.getTaskExecution(betweenId)!.currentIssueId!, { checklist: [true, true], evidence: 'Passed' })
  assert.equal(call('tasks:cancel', betweenId), true)
  await tick()
  assert.equal(agentProcesses.starts.length, startsBeforeCancel)
  assert.equal(store.getTask(betweenId)?.status, 'cancelled')

  GitDeliveryManager.failFinalize = true
  const deliveryId = await start('Delivery failure')
  agentProcesses.plan(deliveryId, [issue])
  await tick()
  await complete(deliveryId)
  assert.equal(store.getTask(deliveryId)?.deliveryStatus, 'failed')
  assert.throws(() => call('tasks:approve', deliveryId), /not awaiting review/)
  GitDeliveryManager.failFinalize = false
  GitDeliveryManager.repository = false
  for (const agentId of ['opencode', 'codex']) {
    const serverId = await start('Server task without Git', agentId)
    const serverExit = async (output: string): Promise<void> => {
      agentProcesses.active.delete(serverId)
      agentProcesses.emit('exit', { taskId: serverId, code: 0, cancelled: false,
        result: { taskId: serverId, status: 'succeeded', output, changedFiles: [] } })
      await tick()
    }
    agentProcesses.createPlan(serverId, [issue])
    await serverExit('Plain text plan summary, not a structured result.')
    const currentId = store.getTaskExecution(serverId)!.currentIssueId!
    assert.equal(agentProcesses.starts.at(-1).issueId, currentId)
    tracker.complete(currentId, { checklist: [true, true], evidence: 'Server validation passed' })
    await serverExit('')
    assert.equal(tracker.get(currentId).evidence, 'Server validation passed')
    assert.equal(store.getTask(serverId)?.status, 'succeeded', 'Completion needs no assistant output')
    assert.equal(store.getTask(serverId)?.deliveryStatus, 'unavailable')
  }
  tracker.close()
  store.close()
  console.log('Task execution passed: CLI-owned state, concurrent labeled plans, scoped scheduling, limits, validation, failed planning, cancellation, and final delivery.')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
