import assert from 'node:assert/strict'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store } from '../src/main/store'
import { registerIpc } from '../src/main/ipc'
import { completionEvidence, nextIssue, parsePlan } from '../src/main/issue-tracker'
import { handlers, testHome, AgentProcessManager, GitDeliveryManager } from './issue-tracker-doubles'

async function main(): Promise<void> {
  const options = { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') }
  const database = join(testHome, '.anvil-composer/anvil.db')
  const store = new Store(database, options)
  store.addProject({ id: 'project', name: 'Test', path: testHome, createdAt: Date.now(), monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
  const { agentProcesses: realAgentProcesses } = registerIpc(() => null)
  const agentProcesses = realAgentProcesses as unknown as AgentProcessManager
  const call = (name: string, input: unknown): any => handlers.get(name)!(null, input)
  const tick = async (): Promise<void> => { for (let index = 0; index < 8; index++) await new Promise((resolve) => setImmediate(resolve)) }
  const issue = { key: 'first', title: 'Small change', description: 'One behavior', labels: ['backend'], priority: 'medium', dependencies: [], status: 'queued', checklist: ['Change behavior', 'Verify result'], validation: 'Run focused test' }
  const wrap = (value: unknown): string => `<anvil-issue-tracker>${JSON.stringify(value)}</anvil-issue-tracker>`
  assert.equal(parsePlan(wrap({ items: Array.from({ length: 50 }, (_, index) => ({ ...issue, key: String(index) })) })).length, 50)
  for (const items of [[], Array(51).fill(issue), [issue, issue], [{ ...issue, checklist: [] }], [{ ...issue, validation: '' }], [{ ...issue, labels: null }], [{ ...issue, priority: 'invalid' }], [{ ...issue, status: 'complete' }], [{ ...issue, dependencies: ['missing'] }], [{ ...issue, dependencies: ['first'] }], [{ ...issue, dependencies: ['second'] }, { ...issue, key: 'second', dependencies: ['first'] }]]) {
    assert.throws(() => parsePlan(wrap({ items })))
  }
  assert.throws(() => parsePlan('<anvil-board>{}</anvil-board>'))
  assert.throws(() => parsePlan(wrap({ items: [issue] }) + wrap({ items: [issue] })))
  const prioritized = { taskId: 'test', limit: 50 as const, phase: 'working' as const, error: null, eventOffset: 0,
    items: parsePlan(wrap({ items: [issue, { ...issue, key: 'second', priority: 'high' }, { ...issue, key: 'third', priority: 'urgent', dependencies: ['first'] }] })) }
  assert.equal(nextIssue(prioritized)?.id, prioritized.items[1].id)
  prioritized.items[1].status = 'complete'
  assert.equal(nextIssue(prioritized)?.id, prioritized.items[0].id, 'Dependencies take precedence over priority')

  const task = await call('tasks:start', { projectId: 'project', agentId: 'codex', prompt: 'Build a feature' })
  await tick()
  assert.match(agentProcesses.starts[0].prompt, /Do not change files/)
  assert.equal(handlers.has('board:review'), false)
  assert.equal(handlers.has('board:get'), false)
  agentProcesses.result(task.id, { items: [issue, { ...issue, key: 'second', priority: 'urgent', dependencies: ['first'] }] })
  await tick()
  const [first, second] = store.getIssueTracker(task.id)!.items
  assert.match(first.id, /^[0-9a-f]{16}$/)
  assert.deepEqual(second.dependencies, [first.id])
  assert.deepEqual(first.labels, ['backend'])
  assert.equal(first.status, 'working')
  assert.equal(second.status, 'queued')
  assert.throws(() => completionEvidence(wrap({ id: second.id, status: 'complete', checklist: [true, true], evidence: 'passed' }), first))
  assert.throws(() => call('tasks:approve', task.id), /not finished/)
  await assert.rejects(call('comments:send', task.id), /not finished/)
  agentProcesses.emit('usage', { taskId: task.id, inputTokens: 5, outputTokens: 2, cachedTokens: 0, totalTokens: 7, costUsd: null })
  agentProcesses.result(task.id, { id: first.id, status: 'complete', checklist: [true, true], evidence: 'Focused tests passed' })
  await tick()
  assert.equal(agentProcesses.starts.length, 3, 'Next issue starts without user approval')
  assert.equal(store.getTask(task.id)?.status, 'running')
  assert.equal(store.getTask(task.id)?.deliveryStatus, 'working')
  assert.equal(GitDeliveryManager.head, 0, 'Git delivery waits until all issues finish')
  assert.equal(store.getIssueTracker(task.id)?.items[0].status, 'complete')
  assert.equal(store.getIssueTracker(task.id)?.items[1].status, 'working')
  agentProcesses.emit('usage', { taskId: task.id, inputTokens: 3, outputTokens: 1, cachedTokens: 0, totalTokens: 4, costUsd: null })
  agentProcesses.result(task.id, { id: second.id, status: 'complete', checklist: [true, true], evidence: 'Second change tested' })
  await tick()
  assert.equal(store.getIssueTracker(task.id)?.phase, 'complete')
  assert.equal(store.getTask(task.id)?.deliveryStatus, 'reviewable')
  assert.equal(store.getTask(task.id)?.totalTokens, 11)
  assert.equal((await call('tasks:diff', task.id)).patch, 'base..commit-1')
  call('tasks:approve', task.id)
  assert.equal(store.getTask(task.id)?.deliveryStatus, 'approved')

  const failed = await call('tasks:start', { projectId: 'project', agentId: 'codex', prompt: 'Validation failure' })
  await tick()
  agentProcesses.result(failed.id, { items: [issue, { ...issue, key: 'second' }] })
  await tick()
  const before = agentProcesses.starts.length
  const current = store.getIssueTracker(failed.id)!.items[0]
  agentProcesses.result(failed.id, { id: current.id, status: 'complete', checklist: [true, false], evidence: 'Failed' })
  await tick()
  assert.equal(agentProcesses.starts.length, before)
  assert.equal(store.getIssueTracker(failed.id)?.phase, 'blocked')
  assert.equal(store.getIssueTracker(failed.id)?.items[0].status, 'blocked')
  assert.equal(store.getTask(failed.id)?.status, 'failed')

  const interrupted = await call('tasks:start', { projectId: 'project', agentId: 'codex', prompt: 'Interrupted task' })
  await tick()
  agentProcesses.cancel(interrupted.id)
  await tick()
  assert.equal(store.getTask(interrupted.id)?.status, 'cancelled')
  assert.equal(store.getIssueTracker(interrupted.id)?.phase, 'blocked')
  const between = await call('tasks:start', { projectId: 'project', agentId: 'codex', prompt: 'Cancel between issues' })
  await tick()
  agentProcesses.result(between.id, { items: [issue, { ...issue, key: 'second' }] })
  await tick()
  const firstBetween = store.getIssueTracker(between.id)!.items[0]
  const startsBeforeCancel = agentProcesses.starts.length
  agentProcesses.result(between.id, { id: firstBetween.id, status: 'complete', checklist: [true, true], evidence: 'Passed' })
  assert.equal(call('tasks:cancel', between.id), true)
  await tick()
  assert.equal(agentProcesses.starts.length, startsBeforeCancel)
  assert.equal(store.getTask(between.id)?.status, 'cancelled')

  GitDeliveryManager.failFinalize = true
  const deliveryFailure = await call('tasks:start', { projectId: 'project', agentId: 'codex', prompt: 'Delivery failure' })
  await tick()
  agentProcesses.result(deliveryFailure.id, { items: [issue] })
  await tick()
  agentProcesses.result(deliveryFailure.id, { id: store.getIssueTracker(deliveryFailure.id)!.items[0].id, status: 'complete', checklist: [true, true], evidence: 'Passed' })
  await tick()
  assert.equal(store.getTask(deliveryFailure.id)?.deliveryStatus, 'failed')
  assert.throws(() => call('tasks:approve', deliveryFailure.id), /not awaiting review/)
  GitDeliveryManager.failFinalize = false
  GitDeliveryManager.repository = false
  const noGit = await call('tasks:start', { projectId: 'project', agentId: 'codex', prompt: 'No Git' })
  await tick()
  agentProcesses.result(noGit.id, { items: [issue] })
  await tick()
  const noGitIssue = store.getIssueTracker(noGit.id)!.items[0]
  agentProcesses.result(noGit.id, { id: noGitIssue.id, status: 'complete', checklist: [true, true], evidence: 'Manual check passed' })
  await tick()
  assert.equal(store.getTask(noGit.id)?.status, 'succeeded')
  assert.equal(store.getTask(noGit.id)?.deliveryStatus, 'unavailable')

  for (const agentId of ['opencode', 'codex']) {
    const serverTask = await call('tasks:start', { projectId: 'project', agentId, prompt: 'Server task result' })
    await tick()
    const serverResult = (payload: unknown): void => {
      agentProcesses.active.delete(serverTask.id)
      // Both server adapters return the assembled turn, separate from persisted lines.
      agentProcesses.emit('exit', {
        taskId: serverTask.id, code: 0, cancelled: false,
        result: { taskId: serverTask.id, status: 'succeeded', output: wrap(payload), changedFiles: [] }
      })
    }
    serverResult({ items: [issue] })
    await tick()
    const serverIssue = store.getIssueTracker(serverTask.id)!.items[0]
    assert.equal(serverIssue.status, 'working')
    assert.equal(agentProcesses.starts.at(-1).issueId, serverIssue.id)
    serverResult({ id: serverIssue.id, status: 'complete', checklist: [true, true], evidence: 'Server validation passed' })
    await tick()
    assert.equal(store.getIssueTracker(serverTask.id)?.phase, 'complete')
    assert.equal(store.getIssueTracker(serverTask.id)?.items[0].evidence, 'Server validation passed')
    assert.equal(store.getTask(serverTask.id)?.status, 'succeeded')
  }

  const restartTask = await call('tasks:start', { projectId: 'project', agentId: 'codex', prompt: 'Restart during an issue' })
  await tick()
  agentProcesses.result(restartTask.id, { items: [issue] })
  await tick()
  const restarted = new Store(database, options)
  assert.equal(restarted.getIssueTracker(restartTask.id)?.phase, 'blocked')
  assert.equal(restarted.getIssueTracker(restartTask.id)?.items[0].status, 'blocked')
  assert.deepEqual(restarted.getIssueTracker(task.id), store.getIssueTracker(task.id))
  assert.ok(restarted.getIssueTracker(task.id)?.items.every((item) => item.completedAt))
  const persisted = restarted.getIssueTracker(task.id)!
  persisted.taskId = randomUUID()
  assert.throws(() => restarted.saveIssueTracker(persisted), /FOREIGN KEY/)
  restarted.removeProject('project')
  assert.equal(restarted.getIssueTracker(task.id), undefined)
  restarted.close()
  store.close()
  console.log('Issue tracker tests passed: metadata, dependency scheduling, sequential execution, final review, failure boundaries, and SQLite persistence.')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
