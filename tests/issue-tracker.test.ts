import { callIssueTool } from '../apps/server/src/issue-tools/server'
import { rendererEvent } from './renderer-fixture'
import { expect, test, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BatchIssue } from '@anvil/protocol/anvil-issue-tracker'
import { Store } from '../apps/server/src/store'
import { registerTestIpc } from './test-ipc'
import { taskState } from './task-state'
import { handlers, testHome, AgentProcessManager, GitDeliveryManager } from './issue-tracker-doubles'

test('schedules dependencies and priorities sequentially and advances to a shippable task without step review', async () => {
  const options = { migrationsFolder: join(process.cwd(), 'apps/server/src/db/migrations') }
  const database = join(testHome, '.anvil-composer/config.json')
  const store = new Store(database, options)
  const workspaceDatabase = store.getWorkspaceDatabasePath('default')
  store.addProject({ id: 'project', name: 'Test', path: testHome, createdAt: Date.now(), monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, shipPushes: false, gitPlatform: 'github' })
  const { agentProcesses: processes } = registerTestIpc()
  const agentProcesses = processes as unknown as AgentProcessManager
  const call = (name: string, input: unknown): any => handlers.get(name)!(rendererEvent, input)
  const tick = async (): Promise<void> => { for (let index = 0; index < 8; index++) await new Promise((resolve) => setImmediate(resolve)) }
  const issue: Omit<BatchIssue, 'parentId'> = { key: 'first', title: 'Small change', description: 'One behavior', labels: ['backend'], priority: 'medium', dependencies: [], checklist: ['Change behavior', 'Verify result'], validation: 'Run focused test' }
  const start = async (prompt: string, agentId = 'codex'): Promise<string> => {
    const task = await call('tasks:start', { projectId: 'project', agentId, prompt })
    await vi.waitFor(() => expect(agentProcesses.starts.some((entry) => entry.taskId === task.id), prompt).toBe(true))
    return task.id
  }
  const submit = async (taskId: string): Promise<string> => {
    const issueId = store.getTaskExecution(taskId)!.currentIssueId!
    callIssueTool(store, taskId, store.getTask(taskId)!.workspaceId, 'anvil_submit_review', { id: issueId, checklist: [true, true], evidence: 'Focused tests passed' })
    const pending = await call('tasks:issues', taskId)
    expect(pending.execution).toMatchObject({ currentIssueId: issueId })
    expect(pending.children.find((child: { id: string }) => child.id === issueId).status).toBe('review')
    expect(pending.reviewReady).toBe(false)
    await expect(call('tasks:issue-diff', { taskId, issueId })).rejects.toThrow(/not finished preparing/)
    agentProcesses.finishTurn(taskId, 'Submitted through the issue tool')
    await tick()
    expect(store.issueTracker('project').get(issueId).status, 'A finished issue completes without developer review').toBe('complete')
    return issueId
  }

  const taskId = await start('Build a feature')
  const tracker = store.issueTracker('project')
  expect(tracker.databasePath).toBe(workspaceDatabase)
  expect(tracker.getParent(store.getTaskExecution(taskId)!.parentIssueId).anvilTaskId).toBe(taskId)
  expect(existsSync(join(testHome, '.anvil-issue-tracker')), 'Starting a task must not create project-local storage').toBe(false)
  expect(agentProcesses.starts[0].projectPath).toBe(testHome)
  expect(handlers.has('board:review')).toBe(false)
  const { key: _key, ...fields } = issue
  const unrelatedTaskId = await start('Unrelated work')
  const unrelated = tracker.create({ ...fields, parentId: store.getTaskExecution(unrelatedTaskId)!.parentIssueId, priority: 'urgent' })
  const otherTaskId = await start('Concurrent plan')
  const [otherIssue] = agentProcesses.createPlan(otherTaskId, [{ ...issue, priority: 'urgent' }])
  agentProcesses.plan(taskId, [
    { ...issue, key: 'dependent', priority: 'urgent', dependencies: ['first'] },
    { ...issue, priority: 'low' },
    { ...issue, key: 'independent', priority: 'high' }
  ])
  await tick()
  const [dependent, prerequisite, independent] = taskState(store, taskId)!.items
  expect(prerequisite.id).toMatch(/^[0-9a-f]{16}$/)
  expect(dependent.dependencies).toStrictEqual([prerequisite.id])
  expect(prerequisite.labels).toStrictEqual(['backend'])
  expect(prerequisite.parentId).toBe(store.getTaskExecution(taskId)!.parentIssueId)
  expect(independent.status, 'Anvil issue tracker chooses priority among ready task issues').toBe('working')
  expect(dependent.status, 'Dependencies override priority').toBe('queued')
  expect(tracker.get(unrelated.id).status).toBe('queued')
  expect(tracker.get(otherIssue.id).status, 'Do not adopt another concurrent plan').toBe('queued')
  agentProcesses.finishTurn(otherTaskId, 'My plan is ready.')
  await tick()
  expect(store.getTaskExecution(otherTaskId)!.issueIds).toStrictEqual([otherIssue.id])
  expect(tracker.get(otherIssue.id).status).toBe('working')
  call('tasks:cancel', otherTaskId)
  await tick()
  const assertReadOnlySnapshot = async (statuses: string[]): Promise<void> => {
    const starts = agentProcesses.starts.length
    const before = tracker.list()
    const execution = store.getTaskExecution(taskId)
    const snapshot = await call('tasks:issues', taskId)
    expect(snapshot.children.map((child: { status: string }) => child.status)).toEqual(statuses)
    await call('tasks:events', taskId)
    expect(agentProcesses.starts.length, 'Sidebar and shared-view reads never start an agent').toBe(starts)
    expect(tracker.list(), 'Navigation reads never claim or change an issue').toEqual(before)
    expect(store.getTaskExecution(taskId)).toEqual(execution)
  }
  await assertReadOnlySnapshot(['queued', 'queued', 'working'])
  const deliveriesBeforeCompletion = GitDeliveryManager.head
  expect('items' in store.getTaskExecution(taskId)!, 'Persist IDs, not duplicate issue records').toBe(false)
  await expect(call('tasks:approve', { taskId, preview: await new GitDeliveryManager().getMergePreview(testHome, 'task') })).rejects.toThrow(/not finished/)
  await expect(call('comments:send', taskId)).rejects.toThrow(/not finished/)
  agentProcesses.emit('usage', { taskId, inputTokens: 5, outputTokens: 2, cachedTokens: 0, totalTokens: 7, costUsd: null })
  agentProcesses.emit('usage', { taskId, inputTokens: 5, outputTokens: 2, cachedTokens: 0, totalTokens: 7, costUsd: null })
  expect(store.getTask(taskId)?.totalTokens).toBe(7)
  const startsBeforeSubmit = agentProcesses.starts.length
  const issueHead = 'd'.repeat(40)
  GitDeliveryManager.worktreeHeadValue = issueHead
  const firstIssueId = await submit(taskId)
  await assertReadOnlySnapshot(['queued', 'working', 'complete'])
  expect(store.getTaskExecution(taskId)?.phase).toBe('working')
  expect(store.getTaskExecution(taskId)?.currentIssueId).toBe(prerequisite.id)
  expect(agentProcesses.starts.length, 'Completion claims the next issue').toBe(startsBeforeSubmit + 1)
  expect(store.getTask(taskId)?.status).toBe('running')
  expect(GitDeliveryManager.head, 'The issue is finalized once').toBe(deliveriesBeforeCompletion + 1)
  expect((await call('tasks:issue-diff', { taskId, issueId: firstIssueId })).patch, 'The issue diff covers only that issue').toBe(`base..${issueHead}`)
  await expect(call('tasks:issue-diff', { taskId, issueId: dependent.id })).rejects.toThrow(/not finished preparing/)
  await expect(call('tasks:issue-diff', { taskId, issueId: unrelated.id })).rejects.toThrow(/does not belong to this task plan/)
  agentProcesses.emit('usage', { taskId, inputTokens: 3, outputTokens: 1, cachedTokens: 0, totalTokens: 4, costUsd: null })
  expect(store.getTask(taskId)?.totalTokens).toBe(11)
  await submit(taskId)
  await assertReadOnlySnapshot(['working', 'complete', 'complete'])
  expect(store.getTaskExecution(taskId)?.currentIssueId).toBe(dependent.id)
  await submit(taskId)
  await assertReadOnlySnapshot(['complete', 'complete', 'complete'])
  expect(agentProcesses.starts.length, 'The last issue claims nothing new').toBe(startsBeforeSubmit + 2)
  expect(store.getTaskExecution(taskId)?.phase).toBe('complete')
  expect(store.getTask(taskId)?.deliveryStatus).toBe('reviewable')
  expect((await call('tasks:diff', taskId)).patch).toBe(`base..${issueHead}`)
  await call('tasks:approve', { taskId, preview: await call('tasks:merge-preview', taskId) })
  expect(store.getTask(taskId)?.deliveryStatus).toBe('approved')

  const helloId = await start('hello')
  const startsAfterHello = agentProcesses.starts.length
  const issuesBeforeHello = tracker.list().length
  agentProcesses.finishTurn(helloId, 'Hello!')
  await tick()
  expect(store.getTask(helloId)?.status).toBe('succeeded')
  expect(store.getTaskExecution(helloId)?.phase).toBe('complete')
  expect(agentProcesses.starts.length).toBe(startsAfterHello)
  expect(tracker.list().length, 'A no-work response creates no issues').toBe(issuesBeforeHello)

  const largePlanId = await start('More than fifty issues')
  agentProcesses.plan(largePlanId, Array.from({ length: 51 }, (_, index) => ({ ...issue, key: String(index) })))
  await tick()
  expect(store.getTask(largePlanId)?.status).toBe('running')
  expect(store.getTaskExecution(largePlanId)?.issueIds.length).toBe(51)
  expect(store.getTaskExecution(largePlanId)?.phase).toBe('working')
  call('tasks:cancel', largePlanId)
  await tick()

  for (const exitCode of [0, 1]) {
    const partialId = await start('Partial planning')
    const [partial] = agentProcesses.createPlan(partialId, [issue])
    if (!exitCode) tracker.block(partial.id)
    agentProcesses.finishTurn(partialId, 'Could not finish planning.', exitCode)
    await tick()
    expect(store.getTask(partialId)?.status).toBe('pending')
    expect(store.getTaskExecution(partialId)!.issueIds).toStrictEqual([])
    expect(tracker.get(partial.id).status, 'Do not claim or mutate partial plans').toBe(exitCode ? 'queued' : 'blocked')
  }
  const failedEmptyId = await start('Failed empty planning')
  agentProcesses.finishTurn(failedEmptyId, 'Planning failed.', 1)
  await tick()
  expect(store.getTask(failedEmptyId)?.status, 'Failed empty planning is not no-work success').toBe('pending')

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
    expect(() => tracker.submitForReview(currentId, completion)).toThrow(/checklist|evidence/)
    agentProcesses.finishTurn(failedId, 'Everything is complete!')
    await tick()
    expect(agentProcesses.starts.length).toBe(before)
    expect(tracker.get(currentId).status).toBe('blocked')
    expect(store.getTask(failedId)?.status, 'Text cannot substitute for persisted completion').toBe('pending')
  }

  const wrongIssueTaskId = await start('Wrong issue completion')
  agentProcesses.plan(wrongIssueTaskId, [issue, { ...issue, key: 'other' }])
  await tick()
  const [assignedId, otherId] = store.getTaskExecution(wrongIssueTaskId)!.issueIds
  tracker.start(otherId)
  tracker.submitForReview(otherId, { checklist: [true, true], evidence: 'Completed the wrong issue' })
  tracker.approve(otherId)
  agentProcesses.finishTurn(wrongIssueTaskId, 'Done.')
  await tick()
  expect(store.getTask(wrongIssueTaskId)?.status).toBe('pending')
  expect(tracker.get(assignedId).status, 'Only assigned issue completion can advance a turn').toBe('blocked')
  expect(tracker.get(otherId).status, 'Do not undo other persisted work').toBe('complete')

  const blockedId = await start('Blocked validation')
  agentProcesses.plan(blockedId, [issue])
  await tick()
  const blockedIssueId = store.getTaskExecution(blockedId)!.currentIssueId!
  tracker.block(blockedIssueId)
  const blocker = 'git commit denied index.lock; Vite listen EPERM'
  agentProcesses.finishTurn(blockedId, blocker)
  await tick()
  expect(store.getTask(blockedId)!.error!).toMatch(/blocked in the Anvil issue tracker/)
  expect(store.readEvents(blockedId).some((event) => event.text === blocker), 'Plain-text failure details remain visible').toBeTruthy()
  expect(tracker.get(blockedIssueId).status).toBe('blocked')

  const betweenId = await start('Cancel between issues')
  agentProcesses.plan(betweenId, [issue, { ...issue, key: 'second' }])
  await tick()
  const startsBeforeCancel = agentProcesses.starts.length
  agentProcesses.completeIssue(betweenId, store.getTaskExecution(betweenId)!.currentIssueId!, { checklist: [true, true], evidence: 'Passed' })
  expect(call('tasks:cancel', betweenId)).toBe(true)
  await tick()
  expect(agentProcesses.starts.length).toBe(startsBeforeCancel)
  expect(store.getTask(betweenId)?.status).toBe('cancelled')

  const deliveryId = await start('Reviewed delivery')
  agentProcesses.plan(deliveryId, [issue])
  await tick()
  await submit(deliveryId)
  expect(store.getTask(deliveryId)?.deliveryStatus).toBe('reviewable')
  await call('tasks:approve', { taskId: deliveryId, preview: await call('tasks:merge-preview', deliveryId) })
  expect(store.getTask(deliveryId)?.deliveryStatus).toBe('approved')
  expect(call('tasks:cancel', unrelatedTaskId)).toBe(true)
  await tick()
  for (const agentId of ['opencode', 'codex']) {
    const serverId = await start('Server task', agentId)
    const serverExit = async (output: string): Promise<void> => {
      agentProcesses.active.delete(serverId)
      agentProcesses.emit('exit', { taskId: serverId, code: 0, cancelled: false,
        result: { taskId: serverId, status: 'succeeded', output, changedFiles: [] } })
      await tick()
    }
    agentProcesses.createPlan(serverId, [issue])
    await serverExit('Plain text plan summary, not a structured result.')
    const currentId = store.getTaskExecution(serverId)!.currentIssueId!
    expect(agentProcesses.starts.at(-1).issueId).toBe(currentId)
    tracker.submitForReview(currentId, { checklist: [true, true], evidence: 'Server validation passed' })
    await serverExit('Submitted for review.')
    expect(store.getTaskExecution(serverId)?.phase).toBe('complete')
    expect(tracker.get(currentId).evidence).toBe('Server validation passed')
    expect(store.getTask(serverId)?.status, 'Completion needs no assistant output').toBe('succeeded')
    expect(store.getTask(serverId)?.deliveryStatus).toBe('reviewable')
  }
  tracker.close()
  store.close()
})
