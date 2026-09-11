import { expect, test, vi } from 'vitest'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Store } from '../src/main/store'
import { createTaskMemory } from '../src/main/memory/task-memory'
import type { ProjectMemory, CompletedTaskMemory } from '../src/main/memory/project-memory'
import type { TaskContext } from '../src/main/tasks/context'
import type { TaskEvent, TaskEventsPage, TaskEventsRequest } from '../src/shared/types'
import { DEFAULT_TASK_EVENT_PAGE_SIZE, MAX_TASK_EVENT_PAGE_SIZE } from '../src/shared/types'
import { handlers, testHome } from './issue-tracker-doubles'
import { rendererEvent } from './renderer-fixture'
import { registerTestIpc } from './test-ipc'
import { onTestCleanup } from './test-cleanup'

const options = { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') }
function setup(database = join(testHome, randomUUID(), 'anvil.db')) {
  const store = new Store(database, options)
  onTestCleanup(() => store.close())
  store.addProject({ id: 'project', name: 'Test', path: testHome, createdAt: 0,
    monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
  for (const id of ['task', 'other', 'empty']) store.addTask({
    id, projectId: 'project', title: id, prompt: 'Summarize this task', cwd: testHome,
    agentId: 'codex', agentLabel: 'Codex', status: 'succeeded', deliveryStatus: 'no_changes', startedAt: 0,
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null,
    filesChanged: 0, additions: 0, deletions: 0
  })
  return { store, database }
}
function event(index: number, taskId = 'task', category: TaskEvent['category'] = 'tool_result'): TaskEvent {
  return { id: `${taskId}-${index}`, taskId, ts: 1, stream: 'stdout', kind: 'output', category, text: `Event ${index}` }
}
function append(store: Store, count: number, taskId = 'task', category: TaskEvent['category'] = 'tool_result') {
  store.transaction(() => {
    for (let index = 0; index < count; index++) store.appendEvent(event(index, taskId, category))
  })
}
const emptyPage = { events: [], oldestCursor: null, newestCursor: null, hasOlder: false, hasNewer: false }

test('defaults to the latest 500, enforces the 4000 maximum and limits history in SQL', () => {
  const { store } = setup()
  append(store, 4105)
  const prepare = vi.spyOn(Database.prototype, 'prepare')
  const page = store.readEventsPage({ taskId: 'task' })
  expect(page.events).toHaveLength(DEFAULT_TASK_EVENT_PAGE_SIZE)
  expect(page.events[0].id).toBe('task-3605')
  expect(page.events.at(-1)?.id).toBe('task-4104')
  expect(page).toMatchObject({ hasOlder: true, hasNewer: false })
  expect(store.readEvents('task')).toEqual(page.events.map(({ sequence: _sequence, ...entry }) => entry))
  expect(store.readEvents('task', MAX_TASK_EVENT_PAGE_SIZE)).toHaveLength(4000)
  expect(store.readMessageTail('task')).toEqual([])
  const queries = prepare.mock.calls.map(([query]) => query).filter((query) => /select .*from "task_events"/i.test(query))
  expect(queries.length).toBeGreaterThan(0)
  expect(queries.every((query) => / limit \?/i.test(query))).toBe(true)
  for (const limit of [0, -1, 1.5, 4001, NaN, Infinity, null, '500']) {
    expect(() => store.readEventsPage({ taskId: 'task', limit } as TaskEventsRequest)).toThrow(/limit/)
  }
})

test('traverses both directions without gaps or duplicates across equal timestamps, interleaved tasks and snapshot upserts', () => {
  const { store, database } = setup()
  store.transaction(() => {
    for (let index = 0; index < 37; index++) {
      store.appendEvent(event(index))
      store.appendEvent(event(index, 'other'))
      if (index % 3 === 0) store.appendEvent({ ...event(index), text: `Updated ${index}` })
    }
  })
  let page = store.readEventsPage({ taskId: 'task', limit: 7 })
  const expected = Array.from({ length: 37 }, (_, index) => `task-${index}`)
  let ids = page.events.map((entry) => entry.id)
  while (page.hasOlder) {
    page = store.readEventsPage({ taskId: 'task', limit: 7, before: page.oldestCursor! })
    ids = [...page.events.map((entry) => entry.id), ...ids]
  }
  expect(ids).toEqual(expected)
  ids = page.events.map((entry) => entry.id)
  while (page.hasNewer) {
    page = store.readEventsPage({ taskId: 'task', limit: 7, after: page.newestCursor! })
    ids.push(...page.events.map((entry) => entry.id))
  }
  expect(ids).toEqual(expected)
  const reopened = new Store(database, options)
  onTestCleanup(() => reopened.close())
  expect(reopened.readEventsPage({ taskId: 'task', limit: 37 })).toEqual(store.readEventsPage({ taskId: 'task', limit: 37 }))
  expect(page.events.at(-1)?.text).toBe('Updated 36')
})

test('concurrent appends and snapshot updates preserve cursors and latest navigation', () => {
  const { store, database } = setup()
  append(store, 12)
  const latest = store.readEventsPage({ taskId: 'task', limit: 4 })
  const writer = new Store(database, options)
  onTestCleanup(() => writer.close())
  writer.appendEvent({ ...event(9), text: 'Final snapshot', ts: 999 })
  writer.appendEvent(event(12))
  writer.appendEvent(event(13))
  const older = store.readEventsPage({ taskId: 'task', limit: 4, before: latest.oldestCursor! })
  expect(older.events.map((entry) => entry.id)).toEqual(['task-4', 'task-5', 'task-6', 'task-7'])
  const refreshed = store.readEventsPage({ taskId: 'task', limit: 4, after: older.newestCursor! })
  expect(refreshed.events[1]).toMatchObject({ id: 'task-9', text: 'Final snapshot', ts: 1, sequence: latest.events[1].sequence })
  expect(refreshed.hasNewer).toBe(true)
  expect(store.readEventsPage({ taskId: 'task', after: latest.newestCursor! }).events.map((entry) => entry.id)).toEqual(['task-12', 'task-13'])
  expect(store.readEventsPage({ taskId: 'task', limit: 4 }).events.map((entry) => entry.id)).toEqual(['task-10', 'task-11', 'task-12', 'task-13'])
})

test('registered IPC validates limits and task-scoped cursors and handles empty and deleted tasks', () => {
  const { store } = setup(join(testHome, '.anvil-composer/anvil.db'))
  const runtime = registerTestIpc()
  onTestCleanup(() => runtime.closeStore())
  const call = (input: unknown): TaskEventsPage => handlers.get('tasks:events-page')!(rendererEvent, input)
  append(store, 4105)
  expect(call({ taskId: 'task' }).events).toHaveLength(500)
  expect(call({ taskId: 'task', limit: 4000 }).events).toHaveLength(4000)
  expect(handlers.get('tasks:events')!(rendererEvent, 'task')).toHaveLength(500)
  for (const limit of [0, -1, 0.5, 4001, NaN, Infinity, null, '500']) {
    expect(() => call({ taskId: 'task', limit })).toThrow(/Invalid IPC request/)
  }
  for (const cursor of [null, 1, {}, { taskId: 'other', sequence: 1 }, { taskId: 'task', sequence: 0 },
    { taskId: 'task', sequence: 1.5 }, { taskId: 'task', sequence: Number.MAX_SAFE_INTEGER + 1 },
    { taskId: 'task', sequence: '1' }, { taskId: 'task', sequence: 1, extra: true }]) {
    for (const direction of ['before', 'after']) expect(() => call({ taskId: 'task', [direction]: cursor })).toThrow(/Invalid IPC request/)
  }
  const cursor = call({ taskId: 'task' }).oldestCursor!
  expect(() => call({ taskId: 'task', before: cursor, after: cursor })).toThrow(/only one/)
  expect(() => store.readEventsPage({ taskId: 'other', before: cursor })).toThrow(/cursor/)
  expect(() => call({ taskId: 'other', before: cursor })).toThrow(/cursor/)
  expect(call({ taskId: 'empty' })).toEqual(emptyPage)
  expect(call({ taskId: 'missing' })).toEqual(emptyPage)
  store.deleteTaskCascade('task')
  expect(call({ taskId: 'task', before: cursor })).toEqual(emptyPage)
  expect(store.readMessageTail('task')).toEqual([])
})

test('old explicit stop markers still prevent restart recovery beyond the maximum page', () => {
  const { store, database } = setup()
  store.updateTask('task', { status: 'cancelled', deliveryStatus: 'finalizing' })
  store.updateTask('other', { status: 'cancelled', deliveryStatus: 'finalizing' })
  store.appendEvent({ ...event(-1), text: 'Stop requested by user.' })
  append(store, 4105)
  expect(store.readEvents('task', 4000).some((entry) => entry.text === 'Stop requested by user.')).toBe(false)
  const reopened = new Store(database, options)
  onTestCleanup(() => reopened.close())
  expect(reopened.getTask('task')).toMatchObject({ status: 'cancelled', deliveryStatus: 'agent_failed' })
  expect(reopened.getTask('other')).toMatchObject({ status: 'pending', deliveryStatus: 'agent_failed' })
})

test('memory receives a bounded chronological message tail even after thousands of tool events', async () => {
  const { store } = setup()
  append(store, 600, 'task', 'message')
  store.transaction(() => {
    for (let index = 600; index < 5100; index++) store.appendEvent(event(index))
  })
  expect(store.readEvents('task').every((entry) => entry.category === 'tool_result')).toBe(true)
  store.setSettings({ memoryEnabled: true })
  const remember = vi.fn<(input: CompletedTaskMemory) => Promise<void>>(async () => {})
  const projectMemory: ProjectMemory = { connect: async () => {}, close: async () => {}, forgetProject: async () => {}, recall: async () => [], rememberCompletedTask: remember }
  const getDiff = vi.fn<TaskContext['gitDelivery']['getDiff']>()
  const memory = createTaskMemory({ store, gitDelivery: { getDiff } as unknown as TaskContext['gitDelivery'] }, projectMemory)
  await memory.rememberCompletedTask(store.getTask('task')!, testHome)
  expect(remember).toHaveBeenCalledOnce()
  const input = remember.mock.calls[0][0]
  expect(input.events).toHaveLength(500)
  expect(input.events[0].id).toBe('task-100')
  expect(input.events.at(-1)?.id).toBe('task-599')
  expect(input.events.every((entry) => entry.category === 'message')).toBe(true)
})
