import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import { Store } from '../apps/server/src/store'
import { createHandlerRegistry } from '../apps/server/src/handler-registry'
import { registerTaskResultNoticeHandlers } from '../apps/server/src/handlers/tasks'
import { workspaceSnapshot } from '../apps/server/src/handlers/workspaces'
import type { Project, Task, TaskResultNotice, TaskResultNoticeChange } from '@anvil/protocol/types'
import { onTestCleanup } from './test-cleanup'

const migrationsFolder = join(process.cwd(), 'apps/server/src/db/migrations')

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'anvil-task-result-notices-'))
  let store = new Store(join(root, 'config.json'), { migrationsFolder })
  onTestCleanup(() => {
    store.close()
    rmSync(root, { recursive: true, force: true })
  })
  const project: Project = {
    id: 'project', name: 'Project', path: join(root, 'project'), createdAt: 1,
    monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github'
  }
  store.addProject(project)
  const addTask = (id: string, input: Partial<Task> = {}, workspaceId = 'default'): Task => store.addTask({
    id, workspaceId, projectId: project.id, style: 'work', reviewPolicy: 'review_each_issue', checkoutMode: 'worktree',
    agentId: 'codex', agentLabel: 'Codex', prompt: id, title: id, cwd: project.path,
    status: 'running', startedAt: 1, exitCode: null, inputTokens: 0, outputTokens: 0,
    cachedTokens: 0, totalTokens: 0, costUsd: null, deliveryStatus: 'working',
    filesChanged: 0, additions: 0, deletions: 0, ...input
  })
  return { root, project, addTask, get store() { return store }, reopen() { store.close(); store = new Store(join(root, 'config.json'), { migrationsFolder }); return store } }
}

test('creates every result kind idempotently and versions later rework results', () => {
  const f = setup()
  f.addTask('review')
  f.addTask('no-changes')
  f.addTask('quick', { style: 'quick', deliveryStatus: 'unavailable' })
  f.addTask('non-git', { checkoutMode: 'local', deliveryStatus: 'unavailable' })

  f.store.updateTask('review', { status: 'succeeded', deliveryStatus: 'reviewable', headCommit: 'head-one' })
  f.store.updateTask('review', { status: 'succeeded', deliveryStatus: 'reviewable', headCommit: 'head-one', totalTokens: 12 })
  f.store.updateTask('no-changes', { status: 'succeeded', deliveryStatus: 'no_changes', headCommit: 'head-empty' })
  f.store.updateTask('quick', { status: 'succeeded' })
  f.store.updateTask('non-git', { status: 'succeeded' })

  expect(f.store.getTaskResultNotices().map(({ taskId, kind, resultVersion, headCommit }) =>
    ({ taskId, kind, resultVersion, headCommit })).sort((a, b) => a.taskId.localeCompare(b.taskId))).toEqual([
    { taskId: 'no-changes', kind: 'no_changes', resultVersion: 1, headCommit: 'head-empty' },
    { taskId: 'non-git', kind: 'completed', resultVersion: 1, headCommit: undefined },
    { taskId: 'quick', kind: 'completed', resultVersion: 1, headCommit: undefined },
    { taskId: 'review', kind: 'reviewable', resultVersion: 1, headCommit: 'head-one' }
  ])

  f.store.updateTask('review', { status: 'running', deliveryStatus: 'working' })
  expect(f.store.getTaskResultNotices().find((notice) => notice.taskId === 'review')?.dismissedAt).toEqual(expect.any(Number))
  f.store.updateTask('review', { status: 'succeeded', deliveryStatus: 'reviewable', headCommit: 'head-two' })
  const versions = f.store.getTaskResultNotices().filter((notice) => notice.taskId === 'review')
  expect(versions.map(({ resultVersion, headCommit, dismissedAt }) => ({ resultVersion, headCommit, dismissed: dismissedAt !== undefined }))).toEqual([
    { resultVersion: 2, headCommit: 'head-two', dismissed: false },
    { resultVersion: 1, headCommit: 'head-one', dismissed: true }
  ])
  f.store.updateTask('review', { deliveryStatus: 'approved', reviewedAt: 50 })
  expect(f.store.getTaskResultNotices().find((notice) => notice.taskId === 'review' && notice.resultVersion === 2)?.dismissedAt)
    .toEqual(expect.any(Number))
})

test('persists acknowledgement timestamps, emits only committed changes, and survives restart', () => {
  const f = setup()
  const changes: TaskResultNoticeChange[] = []
  f.store.subscribeTaskResultNotices((change) => changes.push(change))
  f.addTask('completed', { style: 'quick', deliveryStatus: 'unavailable' })
  f.store.updateTask('completed', { status: 'succeeded' })
  const created = f.store.getTaskResultNotices()[0]
  expect(f.store.markTaskResultNoticeSeen(created.id, 'default', 100).seenAt).toBe(100)
  expect(f.store.markTaskResultNoticeSeen(created.id, 'default', 200).seenAt).toBe(100)
  expect(f.store.dismissTaskResultNotice(created.id, 'default', 300).dismissedAt).toBe(300)
  expect(f.store.dismissTaskResultNotice(created.id, 'default', 400).dismissedAt).toBe(300)
  expect(changes.map((change) => change.notice)).toMatchObject([
    { id: created.id }, { id: created.id, seenAt: 100 }, { id: created.id, seenAt: 100, dismissedAt: 300 }
  ])

  f.addTask('rolled-back', { style: 'quick', deliveryStatus: 'unavailable' })
  expect(() => f.store.transaction(() => {
    f.store.updateTask('rolled-back', { status: 'succeeded' })
    throw new Error('rollback')
  })).toThrow('rollback')
  expect(f.store.getTask('rolled-back')?.status).toBe('running')
  expect(f.store.getTaskResultNotices().some((notice) => notice.taskId === 'rolled-back')).toBe(false)
  expect(changes.some((change) => change.notice?.taskId === 'rolled-back')).toBe(false)

  const reopened = f.reopen()
  expect(reopened.getTaskResultNotices()).toMatchObject([{ id: created.id, seenAt: 100, dismissedAt: 300 }])
})

test('enforces notice ownership and cascades task and project deletion', () => {
  const f = setup()
  f.store.addProject({ ...f.project, id: 'other-project', path: join(f.root, 'other-project') })
  f.addTask('task-delete', { style: 'quick', deliveryStatus: 'unavailable' })
  f.store.updateTask('task-delete', { status: 'succeeded' })
  f.addTask('project-delete', { projectId: 'other-project', style: 'quick', deliveryStatus: 'unavailable' })
  f.store.updateTask('project-delete', { status: 'succeeded' })

  const sqlite = new DatabaseSync(f.store.getWorkspaceDatabasePath('default'))
  onTestCleanup(() => sqlite.close())
  sqlite.exec('PRAGMA foreign_keys = ON')
  expect(() => sqlite.prepare(`INSERT INTO task_result_notices
    (id, workspace_id, project_id, task_id, result_version, kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run('invalid-owner', 'default', 'other-project', 'task-delete', 2, 'completed', 1))
    .toThrow(/FOREIGN KEY constraint failed/)

  const deletedEvents: TaskResultNoticeChange[] = []
  f.store.subscribeTaskResultNotices((change) => { if (!change.notice) deletedEvents.push(change) })
  f.store.deleteTaskCascade('task-delete')
  expect(f.store.getTaskResultNotices().some((notice) => notice.taskId === 'task-delete')).toBe(false)
  f.store.removeProject('other-project')
  expect(f.store.getTaskResultNotices()).toEqual([])
  expect(deletedEvents).toHaveLength(2)
})

test('lists and acknowledges notices through workspace-scoped handlers and snapshots', () => {
  const f = setup()
  f.addTask('default-result', { style: 'quick', deliveryStatus: 'unavailable' })
  f.store.updateTask('default-result', { status: 'succeeded' })
  const other = f.store.createWorkspace('Other')
  f.store.addProject(f.project, other.id)
  f.addTask('other-result', { style: 'quick', deliveryStatus: 'unavailable' }, other.id)
  f.store.updateTask('other-result', { status: 'succeeded' })

  const ipc = createHandlerRegistry()
  registerTaskResultNoticeHandlers(ipc, f.store)
  const listed = ipc.invoke('task-result-notices:list', { workspaceId: 'default', projectId: 'project' }) as TaskResultNotice[]
  expect(listed.map((notice) => notice.taskId)).toEqual(['default-result'])
  const seen = ipc.invoke('task-result-notices:seen', { workspaceId: 'default', noticeId: listed[0].id }) as TaskResultNotice
  expect(seen.seenAt).toEqual(expect.any(Number))
  const dismissed = ipc.invoke('task-result-notices:dismiss', { workspaceId: 'default', noticeId: listed[0].id }) as TaskResultNotice
  expect(dismissed.dismissedAt).toEqual(expect.any(Number))
  expect(workspaceSnapshot(f.store).taskResultNotices).toMatchObject([{ id: listed[0].id }])
  expect(() => ipc.invoke('task-result-notices:list', { workspaceId: other.id })).toThrow('Workspace changed')
  expect(() => ipc.invoke('task-result-notices:seen', { workspaceId: other.id, noticeId: listed[0].id })).toThrow('Workspace changed')
  expect(() => ipc.invoke('task-result-notices:dismiss', { workspaceId: 'default', noticeId: '' })).toThrow('Invalid IPC request')
})
