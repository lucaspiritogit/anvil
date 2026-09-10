import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { NotificationConstructorOptions } from 'electron'
import { expect, test, vi } from 'vitest'
import { Store } from '../src/main/store'
import { registerTaskNotifications } from '../src/main/task-notifications'
import type { Task } from '../src/shared/types'
import { onTestCleanup } from './test-cleanup'

function setup() {
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
  const stop = registerTaskNotifications(store, FakeNotification)
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
