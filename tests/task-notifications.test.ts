import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { NotificationConstructorOptions } from 'electron'
import { expect, test, vi } from 'vitest'
import { TaskIssues } from '../src/main/tasks/task-issues'
import { callIssueTool } from '../src/main/issue-tools/server'
import type { NotificationDeliveryOptions, NotificationAuthorization } from '../src/main/notification-delivery'
import { Store } from '../src/main/store'
import { registerTaskNotifications } from '../src/main/task-notifications'
import type { Task } from '../src/shared/types'
import { onTestCleanup } from './test-cleanup'

function setup(options: NotificationDeliveryOptions = {}) {
  const store = new Store(':memory:', {
    migrationsFolder: join(process.cwd(), 'src/main/db/migrations')
  })
  onTestCleanup(() => store.close())
  const notifications: FakeNotification[] = []
  class FakeNotification extends EventEmitter {
    static isSupported = vi.fn(() => true)
    show = vi.fn()
    close = vi.fn()
    constructor(readonly options: NotificationConstructorOptions) {
      super()
      notifications.push(this)
    }
  }
  const task: Task = {
    workspaceId: 'default', id: 'task', projectId: 'project',
    title: 'Back up files', prompt: 'Back up files', agentId: 'codex', agentLabel: 'Codex',
    cwd: store.getWorkspaceDirectory('default'), status: 'pending', deliveryStatus: 'preparing', startedAt: 1,
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null,
    filesChanged: 0, additions: 0, deletions: 0
  }
  const project = {
    id: 'project', name: 'Test', path: task.cwd, createdAt: 0,
    monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false,
    gitPlatform: 'github' as const
  }
  store.addProject(project)
  store.addTask(task)
  const stop = registerTaskNotifications(store, FakeNotification, options)
  onTestCleanup(stop)
  return { store, task, project, notifications, FakeNotification, stop }
}

test('notifies each status transition once and ignores startup, metadata updates and deletion', () => {
  const { store, notifications, stop } = setup()
  expect(notifications).toHaveLength(0)
  for (const status of ['running', 'pending', 'running', 'succeeded', 'running', 'failed', 'cancelled'] as const) {
    store.updateTask('task', { status })
    store.updateTask('task', { status, totalTokens: 42 })
  }
  expect(notifications.map((notification) => notification.options)).toEqual([
    'Task running', 'Task pending', 'Task running', 'Task completed',
    'Task running', 'Task failed', 'Task cancelled'
  ].map((title) => ({ title, body: 'Back up files' })))
  for (const notification of notifications) expect(notification.show).toHaveBeenCalledOnce()
  stop()
  stop()
  store.updateTask('task', { status: 'running' })
  store.deleteTaskCascade('task')
  expect(notifications).toHaveLength(7)
})

test('tracks tasks in background workspaces without notifying for workspace selection or new tasks', () => {
  const { store, task, project, notifications } = setup()
  const workspace = store.createWorkspace('Work')
  store.addProject(project, workspace.id)
  store.addTask({ ...task, id: 'other', workspaceId: workspace.id })
  store.selectWorkspace(workspace.id)
  expect(notifications).toHaveLength(0)
  store.updateTask(task.id, { status: 'succeeded' })
  store.updateTask('other', { status: 'failed' })
  expect(notifications.map((notification) => notification.options.title)).toEqual(['Task completed', 'Task failed'])
  store.deleteTaskCascade('other')
  store.setSettings({ caffeineMode: true })
  expect(notifications).toHaveLength(2)
})

test('unsupported platforms and notification failures do not interrupt task updates or retry old transitions', () => {
  const { store, FakeNotification, notifications } = setup()
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  onTestCleanup(() => warning.mockRestore())
  FakeNotification.isSupported.mockReturnValue(false)
  store.updateTask('task', { status: 'running' })
  expect(notifications).toHaveLength(0)
  FakeNotification.isSupported.mockImplementationOnce(() => { throw new Error('Unavailable') })
  expect(() => store.updateTask('task', { status: 'failed' })).not.toThrow()
  FakeNotification.isSupported.mockReturnValue(true)
  store.setSettings({ caffeineMode: true })
  expect(notifications).toHaveLength(0)
  store.updateTask('task', { status: 'running' })
  notifications[0].emit('failed', {}, 'OS rejected notification')
  expect(warning).toHaveBeenCalledWith('Could not show task notification:', 'OS rejected notification')
  expect(store.getTask('task')?.status).toBe('running')
})

function plan(f: ReturnType<typeof setup>) {
  const issues = new TaskIssues(f.store)
  issues.initialize(f.task.id, f.project.path)
  const tool = (name: string, args: Record<string, unknown>) => callIssueTool(f.store, f.task.id, 'default', name, args)
  tool('anvil_create_issue', { title: 'Repair notifications', description: 'Deliver alerts', checklist: ['Checked'], validation: 'Tests' })
  issues.finishPlanning(f.task.id)
  const issue = issues.claim(f.task.id)!
  return { issues, issue, tool, review: () => tool('anvil_submit_review', { id: issue.id, checklist: [true], evidence: 'Tests passed' }) }
}

test('issue tools wait for finalized readiness in a background workspace and rework permits another review', () => {
  const f = setup()
  const p = plan(f)
  f.store.selectWorkspace(f.store.createWorkspace('Other').id)
  p.review()
  expect(f.notifications).toHaveLength(0)
  p.issues.finishIssue(f.task.id)
  expect(f.notifications.map((n) => n.options)).toEqual([{
    title: 'Subtask ready for review: Repair notifications', body: `Back up files · ${p.issue.id}`
  }])
  p.issues.rejectIssue(f.task.id)
  p.review()
  p.issues.finishIssue(f.task.id)
  p.issues.stop(f.task.id, 'Interrupted')
  expect(f.notifications.map((n) => n.options.title)).toEqual([
    'Subtask ready for review: Repair notifications', 'Subtask ready for review: Repair notifications',
    'Subtask blocked: Repair notifications'
  ])
  f.store.setSettings({ caffeineMode: true })
  f.stop()
  const dispose = registerTaskNotifications(f.store, f.FakeNotification)
  onTestCleanup(dispose)
  f.store.setSettings({ caffeineMode: false })
  expect(f.notifications).toHaveLength(3)
})

test('rolled-back issue tools and nested task changes never alert or advance the baseline', () => {
  const f = setup()
  const p = plan(f)
  expect(() => f.store.transaction(() => {
    p.review()
    f.store.updateTask(f.task.id, { status: 'cancelled' })
    throw new Error('Rollback')
  })).toThrow('Rollback')
  expect(f.notifications).toHaveLength(0)
  p.review()
  expect(f.notifications).toHaveLength(0)
  p.issues.finishIssue(f.task.id)
  expect(f.notifications).toHaveLength(1)
  expect(() => f.store.transaction(() => {
    try { f.store.transaction(() => { p.tool('anvil_block_issue', { id: p.issue.id }); throw new Error('Nested') }) } catch {}
  })).not.toThrow()
  expect(f.notifications).toHaveLength(1)
})

test('deleting active work and disposing listeners does not send a blocked alert', () => {
  const f = setup()
  const p = plan(f)
  f.store.transaction(() => { p.issues.stop(f.task.id, 'Deleted'); f.store.deleteTaskCascade(f.task.id) })
  expect(f.notifications).toHaveLength(0)
  f.stop()
  f.store.addTask({ ...f.task, id: 'later' })
  f.store.updateTask('later', { status: 'running' })
  expect(f.notifications).toHaveLength(0)
})

test('first-use grant delivers a subtask event once; denial drops it without activity retries', async () => {
  let resolve!: (value: NotificationAuthorization) => void
  const authorize = vi.fn(() => new Promise<NotificationAuthorization>((done) => { resolve = done }))
  const f = setup({ authorize, onUnavailable: () => {} })
  const p = plan(f)
  p.review()
  p.issues.finishIssue(f.task.id)
  f.store.setSettings({ caffeineMode: true })
  expect(authorize).toHaveBeenCalledOnce()
  resolve('granted')
  await vi.waitFor(() => expect(f.notifications).toHaveLength(1))
  p.issues.rejectIssue(f.task.id)
  p.review()
  p.issues.finishIssue(f.task.id)
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  onTestCleanup(() => warning.mockRestore())
  resolve('denied')
  await vi.waitFor(() => expect(warning).toHaveBeenCalled())
  f.store.setSettings({ caffeineMode: false })
  expect(authorize).toHaveBeenCalledTimes(2)
  expect(f.notifications).toHaveLength(1)
})

test('a committed block tool alerts once and a later requeue and block alerts again', () => {
  const f = setup()
  const p = plan(f)
  p.tool('anvil_block_issue', { id: p.issue.id })
  expect(f.notifications.map((n) => n.options.title)).toEqual(['Subtask blocked: Repair notifications'])
  p.tool('anvil_requeue_issue', { id: p.issue.id })
  p.tool('anvil_start_issue', { id: p.issue.id })
  p.tool('anvil_block_issue', { id: p.issue.id })
  expect(f.notifications).toHaveLength(2)
})

test('a failing Store observer cannot roll back committed issue work or prevent other observers', () => {
  const f = setup()
  const p = plan(f)
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  onTestCleanup(() => warning.mockRestore())
  onTestCleanup(f.store.subscribeActivity(() => { throw new Error('Broken listener') }))
  const observed = vi.fn()
  onTestCleanup(f.store.subscribeActivity(observed))
  expect(() => p.review()).not.toThrow()
  expect(observed).toHaveBeenCalledOnce()
  expect(p.issues.snapshot(f.task.id)?.children[0].status).toBe('review')
  expect(f.notifications).toHaveLength(0)
  p.issues.finishIssue(f.task.id)
  expect(f.notifications).toHaveLength(1)
})


test('review alerts wait for the stopping guard to clear, and no-op submissions never alert', () => {
  const f = setup()
  f.stop()
  let ready = false
  onTestCleanup(registerTaskNotifications(f.store, f.FakeNotification, {}, () => ready))
  const p = plan(f)
  p.review()
  p.issues.finishIssue(f.task.id)
  expect(f.notifications).toHaveLength(0)
  ready = true
  f.store.activityChanged()
  f.store.activityChanged()
  expect(f.notifications).toHaveLength(1)
  ready = false
  p.issues.rejectIssue(f.task.id)
  p.review()
  // The verified completion transaction goes directly from submitted to complete.
  const tracker = f.store.issueTracker(f.task.projectId, f.task.workspaceId)
  try {
    tracker.recordCommits(p.issue.id, { baseCommit: 'base', headCommit: 'base' })
    tracker.completeNoChanges(p.issue.id, { baseCommit: 'base', headCommit: 'base' })
  } finally { tracker.close() }
  f.store.activityChanged()
  expect(f.notifications).toHaveLength(1)
})

for (const deliveryStatus of ['reviewable', 'no_changes', 'failed'] as const) {
  test(`parent completion waits for Git delivery: ${deliveryStatus}`, () => {
    const f = setup()
    f.store.updateTask(f.task.id, { branchName: 'anvil/task', baseCommit: 'base' })
    f.store.updateTask(f.task.id, { status: 'succeeded', deliveryStatus: 'finalizing' })
    f.store.updateTask(f.task.id, { deliveryStatus: 'did_not_commit' })
    expect(f.notifications).toHaveLength(0)
    f.store.updateTask(f.task.id, { deliveryStatus })
    f.store.updateTask(f.task.id, { deliveryStatus, totalTokens: 10 })
    expect(f.notifications.map((n) => n.options.title)).toEqual(deliveryStatus === 'failed' ? [] : ['Task completed'])
  })
}
