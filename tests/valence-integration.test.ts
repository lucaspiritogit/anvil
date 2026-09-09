import { rendererEvent } from './renderer-fixture'
import Database from 'better-sqlite3'
import { expect, test, vi } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { onTestCleanup } from './test-cleanup'
import { TaskIssues } from '../src/main/tasks/task-issues'
import { IssueTracker } from '../src/main/valence/tracker'
import { openCliTracker } from '../src/main/valence/connection'
import { Store } from '../src/main/store'
import { registerTestIpc } from './test-ipc'
import { handlers, testHome, AgentProcessManager } from './issue-tracker-doubles'

test('cascades task-owned plans on project removal', async () => {
  const store = new Store(join(testHome, '.anvil-composer/anvil.db'), {
    migrationsFolder: join(process.cwd(), 'src/main/db/migrations')
  })
  store.addProject({ id: 'project', name: 'Test', path: testHome, createdAt: 0, monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
  const tracker = store.issueTracker('project')
  const input = { title: 'Unrelated client work', description: 'Keep this outside the Anvil task', checklist: ['Verify'], validation: 'Run test', priority: 'urgent' as const }
  const { agentProcesses: processes } = registerTestIpc()
  const agentProcesses = processes as unknown as AgentProcessManager
  const task = await handlers.get('tasks:start')!(rendererEvent, { projectId: 'project', agentId: 'codex', prompt: 'App change' })
  const tick = async (): Promise<void> => { for (let index = 0; index < 8; index++) await new Promise((resolve) => setImmediate(resolve)) }
  await tick()
  agentProcesses.plan(task.id, [{ ...input, key: 'change', title: 'App change', labels: [], dependencies: [], priority: 'low' }])
  await tick()
  const unrelatedTask = { ...store.getTask(task.id)!, id: randomUUID() }
  store.addTask(unrelatedTask)
  const unrelated = tracker.create({ ...input, parentId: tracker.createParent({ anvilTaskId: unrelatedTask.id, title: 'External work' }).id })
  const issue = tracker.list().find((entry) => entry.title === 'App change')
  expect.assert(issue, 'Anvil-created issues must be visible to another Valence client')
  expect(issue.status).toBe('working')
  expect(tracker.get(unrelated.id).status, 'Anvil must not claim unrelated higher-priority issues').toBe('queued')
  expect(agentProcesses.starts.at(-1)!.prompt).toMatch(/vl --project/)
  // Model an agent submitting through vl and the developer approving before the turn report arrives.
  tracker.submitForReview(issue.id, { checklist: [true], evidence: 'CLI validation passed' })
  tracker.approve(issue.id)
  const completedAt = tracker.get(issue.id).completedAt
  agentProcesses.finishTurn(task.id, 'Finished. See Valence for validation evidence.')
  await tick()
  expect(tracker.get(issue.id).evidence).toBe('CLI validation passed')
  expect(tracker.get(issue.id).completedAt).toBe(completedAt)
  expect(store.getTask(task.id)?.status).toBe('succeeded')
  const removing = await handlers.get('tasks:start')!(rendererEvent, { projectId: 'project', agentId: 'codex', prompt: 'Remove project' })
  await tick()
  agentProcesses.plan(removing.id, [{ ...input, key: 'removing' }])
  await tick()
  const removingIssueId = store.getTaskExecution(removing.id)!.currentIssueId!
  await handlers.get('projects:remove')!(rendererEvent, 'project')
  expect(agentProcesses.isRunning(removing.id), 'Removing a project stops its Anvil agents').toBe(false)
  for (const id of [removingIssueId, issue.id, unrelated.id]) expect(() => tracker.get(id)).toThrow(/not found/)
  expect(tracker.listParents()).toEqual([])
  tracker.close()
  store.close()
})

function snapshotFixture() {
  const directory = mkdtempSync(join(testHome, 'snapshot-'))
  onTestCleanup(() => rmSync(directory, { recursive: true, force: true }))
  const store = new Store(join(testHome, '.anvil-composer/anvil.db'), {
    migrationsFolder: join(process.cwd(), 'src/main/db/migrations')
  })
  onTestCleanup(() => store.close())
  const projectId = randomUUID()
  const taskId = randomUUID()
  const worktree = join(directory, 'worktree')
  mkdirSync(worktree)
  store.addProject({ id: projectId, name: 'Snapshot', path: directory, createdAt: 0, monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
  store.addTask({
    id: taskId, projectId, title: 'Snapshot', prompt: 'Show issues', cwd: worktree,
    agentId: 'codex', agentLabel: 'Codex', status: 'pending', deliveryStatus: 'working', startedAt: 0,
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null,
    filesChanged: 0, additions: 0, deletions: 0
  })
  registerTestIpc()
  const read = () => handlers.get('tasks:issues')!(rendererEvent, taskId)
  return { directory, worktree, store, taskId, read, issues: new TaskIssues(store) }
}

test.each(['start', 'complete'] as const)('task %s ignores standalone storage and unrelated historical execution metadata', (operation) => {
  const { directory, store, taskId, issues } = snapshotFixture()
  const state = issues.initialize(taskId, directory)
  const tracker = store.issueTracker(store.getTask(taskId)!.projectId)
  onTestCleanup(() => tracker.close())
  const child = tracker.create({ parentId: state.parentIssueId, title: 'Current work',
    description: 'Use embedded storage', checklist: ['Verify'], validation: 'Run test' })
  issues.finishPlanning(taskId)
  if (operation === 'complete') {
    issues.claim(taskId)
    tracker.submitForReview(child.id, { checklist: [true], evidence: 'Verified in Anvil' })
    tracker.approve(child.id)
  }

  // Historical task JSON need not contain the old standalone parent mapping.
  const historicalTaskId = randomUUID()
  store.addTask({ ...store.getTask(taskId)!, id: historicalTaskId })
  const connection = new Database(tracker.databasePath, { fileMustExist: true })
  onTestCleanup(() => { connection.close() })
  connection.prepare('INSERT INTO task_executions (task_id, state) VALUES (?, ?)').run(historicalTaskId,
    JSON.stringify({ taskId: historicalTaskId, projectPath: directory, phase: 'complete', issueIds: [], currentIssueId: null, error: null }))
  mkdirSync(join(directory, '.valence'))
  const standalone = new Database(join(directory, '.valence/sqlite.db'))
  onTestCleanup(() => { standalone.close() })
  standalone.exec('CREATE TABLE parent_issues (id TEXT, title TEXT, description TEXT); CREATE TABLE issues (id TEXT)')

  if (operation === 'start') {
    expect(issues.claim(taskId)?.id).toBe(child.id)
    expect(tracker.get(child.id).status).toBe('working')
  } else {
    issues.finishIssue(taskId)
    expect(store.getTaskExecution(taskId)?.phase).toBe('complete')
    expect(tracker.get(child.id).evidence).toBe('Verified in Anvil')
  }
  expect(standalone.prepare('SELECT * FROM parent_issues').all()).toEqual([])
  expect(connection.prepare('SELECT * FROM valence_imports').all()).toEqual([])
})

test.each(['missing', 'changed'] as const)('recovers embedded plans with %s standalone storage and an old import receipt', (sourceStatus) => {
  const { directory, store, taskId, issues } = snapshotFixture()
  const state = issues.initialize(taskId, directory)
  const projectId = store.getTask(taskId)!.projectId
  const tracker = store.issueTracker(projectId)
  onTestCleanup(() => tracker.close())
  const child = tracker.create({ parentId: state.parentIssueId, title: 'Imported work',
    description: 'Already stored in Anvil', checklist: ['Verify'], validation: 'Resume after restart' })
  issues.finishPlanning(taskId)
  issues.claim(taskId)
  const sourcePath = join(directory, '.valence/sqlite.db')
  if (sourceStatus === 'changed') {
    mkdirSync(join(directory, '.valence'))
    writeFileSync(sourcePath, 'Standalone storage changed after cutover')
  }
  const connection = new Database(tracker.databasePath, { fileMustExist: true })
  onTestCleanup(() => { connection.close() })
  connection.prepare('INSERT INTO valence_imports (source_path, project_id, fingerprint, parents, imported_at) VALUES (?, ?, ?, ?, ?)')
    .run(sourcePath, projectId, 'old-fingerprint', JSON.stringify({ [state.parentIssueId]: taskId }), 1)
  const receipt = connection.prepare('SELECT * FROM valence_imports').all()
  store.close()

  const reopened = new Store(tracker.databasePath, { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') })
  onTestCleanup(() => reopened.close())
  const recovered = new TaskIssues(reopened)
  expect(recovered.snapshot(taskId)?.children[0].id).toBe(child.id)
  expect(recovered.resume(taskId).phase).toBe('recovering')
  const client = openCliTracker(directory, tracker.databasePath)
  onTestCleanup(() => client.close())
  client.submitForReview(child.id, { checklist: [true], evidence: 'Completed through embedded CLI' })
  client.approve(child.id)
  recovered.finishRecovery(taskId)
  expect(reopened.getTaskExecution(taskId)?.phase).toBe('complete')
  expect(recovered.snapshot(taskId)?.children[0].evidence).toBe('Completed through embedded CLI')
  expect(connection.prepare('SELECT * FROM valence_imports').all()).toEqual(receipt)
})

test('snapshot reads current parent children during planning and after the execution scope freezes', () => {
  const { directory, store, taskId, read, issues } = snapshotFixture()
  const state = issues.initialize(taskId, directory)
  const tracker = store.issueTracker(store.getTask(taskId)!.projectId)
  onTestCleanup(() => tracker.close())
  const input = { title: 'Planned', description: 'Summary', checklist: ['Check'], validation: 'Test' }
  const otherTaskId = randomUUID()
  store.addTask({ ...store.getTask(taskId)!, id: otherTaskId })
  const otherParent = tracker.createParent({ anvilTaskId: otherTaskId, title: 'Other task' })
  tracker.create({ ...input, parentId: otherParent.id })
  const parent = tracker.getParent(state.parentIssueId)
  expect(read()).toEqual({ parent, children: [] })
  const planned = tracker.create({ ...input, parentId: parent.id })
  expect(read()).toEqual({ parent, children: [planned] })
  expect(store.getTaskExecution(taskId)).toEqual(state)
  expect(issues.list(taskId)).toEqual([])
  issues.finishPlanning(taskId)
  const frozen = store.getTaskExecution(taskId)
  // A fresh adapter restores the association from persisted execution metadata.
  const restarted = new TaskIssues(store)
  expect(restarted.snapshot(taskId)).toEqual(read())
  const later = tracker.create({ ...input, title: 'Added later', parentId: parent.id })
  tracker.updateParent(parent.id, { description: 'Current parent summary' })
  tracker.start(planned.id)
  for (const status of ['working', 'blocked', 'review', 'complete'] as const) {
    if (status === 'blocked') tracker.block(planned.id)
    if (status === 'review') {
      tracker.requeue(planned.id)
      tracker.start(planned.id)
      tracker.submitForReview(planned.id, { checklist: [true], evidence: 'Checked externally' })
    }
    if (status === 'complete') tracker.approve(planned.id)
    const before = tracker.list()
    const snapshot = read()
    expect(snapshot.parent).toEqual(tracker.getParent(parent.id))
    expect(snapshot.children).toEqual([tracker.get(planned.id), later])
    expect(snapshot.children[0].status).toBe(status)
    expect(restarted.snapshot(taskId)).toEqual(snapshot)
    expect(tracker.list()).toEqual(before)
    expect(store.getTaskExecution(taskId)).toEqual(frozen)
    expect(issues.list(taskId).map((issue) => issue.id)).toEqual([planned.id])
  }
})

test('snapshot distinguishes absent metadata, deleted tasks, and unavailable storage without initializing it', () => {
  const { directory, store, taskId, read } = snapshotFixture()
  expect(read()).toBeNull()
  store.saveTaskExecution({ taskId, projectPath: directory, parentIssueId: 'missing', phase: 'planning', issueIds: [], currentIssueId: null, error: null })
  const before = store.getTaskExecution(taskId)
  expect(read).toThrow('Parent issue not found: missing')
  expect(store.getTaskExecution(taskId)).toEqual(before)
  store.deleteTaskCascade(taskId)
  expect(read).toThrow('Task not found')
  expect(() => handlers.get('tasks:issues')!(rendererEvent, 'unknown-task')).toThrow('Task not found')
})

test('snapshot closes trackers on successful reads and failed parent or child reads', () => {
  const { directory, store, taskId, read, issues } = snapshotFixture()
  const state = issues.initialize(taskId, directory)
  const close = vi.spyOn(IssueTracker.prototype, 'close')
  expect(read().children).toEqual([])
  expect(close).toHaveBeenCalledTimes(1)
  store.saveTaskExecution({ ...state, parentIssueId: 'missing-parent' })
  expect(read).toThrow(/parent.*not found/i)
  expect(close).toHaveBeenCalledTimes(2)
  store.saveTaskExecution(state)
  vi.spyOn(IssueTracker.prototype, 'list').mockImplementationOnce(() => { throw new Error('Cannot read children') })
  expect(read).toThrow('Cannot read children')
  expect(close).toHaveBeenCalledTimes(3)
  expect(store.getTaskExecution(taskId)).toEqual(state)
})

test('reopened storage restores child snapshots and tagged history alongside legacy parent events', () => {
  const { directory, store, taskId, issues } = snapshotFixture()
  const state = issues.initialize(taskId, directory)
  const tracker = store.issueTracker(store.getTask(taskId)!.projectId)
  onTestCleanup(() => tracker.close())
  const child = tracker.create({ parentId: state.parentIssueId, title: 'Persisted child',
    description: 'Survive restart', checklist: ['Checked'], validation: 'Reopen storage' })
  issues.finishPlanning(taskId)
  tracker.start(child.id)
  tracker.submitForReview(child.id, { checklist: [true], evidence: 'Saved before restart' })
  tracker.approve(child.id)
  store.appendEvent({ id: `${taskId}-legacy`, taskId, ts: 1, stream: 'stdout', kind: 'output', category: 'message', text: 'Historical parent output' })
  store.appendEvent({ id: `${taskId}-child`, taskId, issueId: child.id, ts: 2, stream: 'stdout', kind: 'output', category: 'message', text: 'Only this child output' })
  const expectedSnapshot = issues.snapshot(taskId)
  const expectedEvents = store.readEvents(taskId)
  store.close()
  const reopened = new Store(join(testHome, '.anvil-composer/anvil.db'), {
    migrationsFolder: join(process.cwd(), 'src/main/db/migrations')
  })
  onTestCleanup(() => reopened.close())
  expect(new TaskIssues(reopened).snapshot(taskId)).toEqual(expectedSnapshot)
  expect(reopened.readEvents(taskId)).toEqual(expectedEvents)
  expect(reopened.readEvents(taskId).filter((event) => event.issueId === child.id).map((event) => event.text))
    .toEqual(['Only this child output'])
  expect(reopened.readEvents(taskId).find((event) => event.text === 'Historical parent output')?.issueId).toBeUndefined()
})

test('initialization and claiming roll back together and retries retain task ownership', () => {
  const { directory, store, taskId, issues } = snapshotFixture()
  const tracker = store.issueTracker(store.getTask(taskId)!.projectId)
  const save = vi.spyOn(store, 'saveTaskExecution')
  save.mockImplementationOnce(() => { throw new Error('Execution write failed') })
  expect(() => issues.initialize(taskId, directory)).toThrow('Execution write failed')
  expect(tracker.listParents()).toEqual([])
  expect(store.getTaskExecution(taskId)).toBeUndefined()
  const state = issues.initialize(taskId, directory)
  expect(issues.initialize(taskId, directory)).toEqual(state)
  expect(tracker.listParents()).toHaveLength(1)
  expect(tracker.getParent(state.parentIssueId).anvilTaskId).toBe(taskId)
  expect(() => issues.initialize(taskId, directory + '/wrong')).toThrow(/project/)
  const otherId = randomUUID()
  store.addTask({ ...store.getTask(taskId)!, id: otherId })
  const other = issues.initialize(otherId, directory)
  store.saveTaskExecution({ ...state, parentIssueId: other.parentIssueId })
  expect(() => issues.initialize(taskId, directory)).toThrow(/another task/)
  store.saveTaskExecution(state)

  const child = tracker.create({ parentId: state.parentIssueId, title: 'Atomic claim',
    description: 'Rollback', checklist: ['Verify'], validation: 'Inject failure' })
  expect(() => issues.claim(taskId)).toThrow(/not ready/)
  expect(tracker.get(child.id).status).toBe('queued')
  issues.finishPlanning(taskId)
  save.mockImplementationOnce(() => { throw new Error('Claim write failed') })
  expect(() => issues.claim(taskId)).toThrow('Claim write failed')
  expect(tracker.get(child.id).status).toBe('queued')
  expect(store.getTaskExecution(taskId)?.currentIssueId).toBeNull()
  expect(issues.claim(taskId)?.id).toBe(child.id)
  expect(() => issues.claim(taskId)).toThrow(/not ready/)
  // A fresh adapter has no ownership of the old turn's claim.
  new TaskIssues(store).stop(taskId, 'Interrupted')
  expect(tracker.get(child.id).status).toBe('working')
  issues.stop(taskId, 'Owned stop')
  expect(tracker.get(child.id).status).toBe('blocked')
  issues.resume(taskId)
  expect(() => issues.finishRecovery(taskId)).toThrow(/not complete/)
  tracker.requeue(child.id)
  tracker.start(child.id)
  tracker.submitForReview(child.id, { checklist: [true], evidence: 'External client validated' })
  tracker.approve(child.id)
  issues.finishRecovery(taskId)
  expect(store.getTaskExecution(taskId)?.phase).toBe('complete')
})

test('deleting a task preserves other tasks and project plans', () => {
  const { directory, store, taskId, issues } = snapshotFixture()
  const task = store.getTask(taskId)!
  const otherId = randomUUID()
  const projectId = randomUUID()
  mkdirSync(directory + '/other')
  store.addProject({ ...store.getProjects().find((project) => project.id === task.projectId)!, id: projectId, path: directory + '/other' })
  store.addTask({ ...task, id: otherId })
  const remoteId = randomUUID()
  store.addTask({ ...task, id: remoteId, projectId })
  const states = [
    issues.initialize(taskId, directory),
    issues.initialize(otherId, directory),
    issues.initialize(remoteId, directory + '/other')
  ]
  const children = states.map((state) => store.issueTracker(store.getTask(state.taskId)!.projectId).create({
    parentId: state.parentIssueId, title: state.taskId, description: 'Keep ownership',
    checklist: ['Check'], validation: 'Delete task'
  }))
  store.deleteTaskCascade(taskId)
  expect(() => store.issueTracker(task.projectId).get(children[0].id)).toThrow(/not found/)
  expect(issues.snapshot(otherId)?.children).toEqual([children[1]])
  expect(issues.snapshot(remoteId)?.children).toEqual([children[2]])
})

test('reuses an existing task parent and recovers a persisted interrupted claim', () => {
  const { directory, store, taskId, issues } = snapshotFixture()
  const tracker = store.issueTracker(store.getTask(taskId)!.projectId)
  const parent = tracker.createParent({ anvilTaskId: taskId, title: 'Existing plan' })
  expect(issues.initialize(taskId, directory).parentIssueId).toBe(parent.id)
  const child = tracker.create({ parentId: parent.id, title: 'Interrupted work',
    description: 'Recover', checklist: ['Verify'], validation: 'Restart' })
  issues.finishPlanning(taskId)
  issues.claim(taskId)
  store.close()
  const reopened = new Store(join(testHome, '.anvil-composer/anvil.db'), {
    migrationsFolder: join(process.cwd(), 'src/main/db/migrations')
  })
  onTestCleanup(() => reopened.close())
  const recovered = new TaskIssues(reopened)
  expect(reopened.getTaskExecution(taskId)?.phase).toBe('blocked')
  expect(reopened.getTaskExecution(taskId)?.currentIssueId).toBe(child.id)
  const client = reopened.issueTracker(reopened.getTask(taskId)!.projectId)
  expect(client.get(child.id).status).toBe('working')
  recovered.resume(taskId)
  expect(() => recovered.finishRecovery(taskId)).toThrow(/not complete/)
  client.submitForReview(child.id, { checklist: [true], evidence: 'Finished after interruption' })
  client.approve(child.id)
  recovered.finishRecovery(taskId)
  expect(reopened.getTaskExecution(taskId)?.phase).toBe('complete')
  expect(recovered.initialize(taskId, directory).parentIssueId).toBe(parent.id)
})
