import { beforeEach, expect, test, vi } from 'vitest'
import { useStore } from '../src/renderer/src/state/store'
import { enqueueWorkspaceRequest } from '../src/renderer/src/state/workspace-requests'
import type { Project, Task, TaskEvent, TaskEventsPage, TaskEventsRequest, WorkspaceSnapshot } from '../src/shared/types'
import { pageTaskEvents } from './e2e/fixture/task-events'

const task = (id: string, projectId = 'project'): Task => ({
  id, workspaceId: 'default', projectId, title: id, prompt: id, cwd: '/tmp', agentId: 'codex', agentLabel: 'Codex',
  status: 'running', deliveryStatus: 'working', startedAt: 0,
  inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null,
  filesChanged: 0, additions: 0, deletions: 0
})
const project = (id: string): Project => ({ id, name: id, path: '/tmp', createdAt: 0,
  monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
const event = (sequence: number, taskId = 'a', text = `Event ${sequence}`): TaskEvent & { sequence: number } => ({
  id: `${taskId}-${sequence}`, taskId, sequence, ts: 1, text, stream: 'stdout', kind: 'output', category: 'tool_result'
})
const rows = (start: number, count: number, taskId = 'a') => Array.from({ length: count }, (_, i) => event(start + i, taskId))
const page = (events: TaskEvent[], input: TaskEventsRequest = { taskId: 'a' }) => pageTaskEvents(events, input)
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const state = () => useStore.getState()
const cached = (id = 'a') => state().eventsByTask[id]
const snapshot = (id = 'other'): WorkspaceSnapshot => ({
  workspace: { id, name: id, createdAt: 0 }, workspaces: [], projects: [project('project')], tasks: [task('a')],
  settings: {} as WorkspaceSnapshot['settings'],
  preferences: { lastProjectId: 'project', composer: { agentId: '', modelsByAgent: {}, reasoningByAgentModel: {} } }
})

beforeEach(() => {
  state().showHome()
  useStore.setState({ ...useStore.getInitialState(), ready: true, activeWorkspaceId: 'default',
    activeProjectId: 'project', projects: [project('project'), project('other')], tasks: [task('a'), task('b', 'other')] })
  vi.stubGlobal('window', { anvil: {
    tasks: { eventsPage: vi.fn(async (input: TaskEventsRequest) => page([event(1, input.taskId)], input)),
      delete: vi.fn(async () => {}), start: vi.fn(async () => task('created')) },
    comments: { send: vi.fn(async (id: string) => ({ task: task(id), comments: [] })) },
    projects: { remove: vi.fn(async () => [project('other')]), add: vi.fn(async () => project('added')) },
    workspaces: { select: vi.fn(async () => snapshot()), setPreferences: vi.fn(async () => {}) }
  } })
})

test('deduplicates initial reads and preserves the same task cache across panel opens', async () => {
  const gate = deferred<TaskEventsPage>()
  const read = vi.mocked(window.anvil.tasks.eventsPage).mockReturnValue(gate.promise)
  const first = state().openTask('a')
  const second = state().openTask('a')
  expect(state().taskEventHistory).toMatchObject({ taskId: 'a', loading: 'initial' })
  await Promise.resolve()
  expect(read).toHaveBeenCalledExactlyOnceWith({ taskId: 'a', limit: 500 })
  gate.resolve(page(rows(1, 10)))
  await Promise.all([first, second])
  const retained = cached()
  await state().openTask('a')
  expect(cached()).toBe(retained)
  expect(read).toHaveBeenCalledTimes(1)
})

const exits: [string, () => void | Promise<void>][] = [
  ['Home', () => state().showHome()],
  ['composer focus', () => state().focusTaskComposer()],
  ['task switch', () => state().openTask('b')],
  ['project selection', () => state().selectProject('other')],
  ['project removal', () => state().removeProject('project')],
  ['project addition', () => state().addProject()],
  ['task deletion', () => state().deleteTask('a')],
  ['task creation navigation', () => state().startTask({ agentId: 'codex', prompt: 'new' })],
  ['workspace switch', () => state().selectWorkspace('other')],
  ['workspace snapshot', () => state().applyWorkspaceSnapshot(snapshot())],
  ['snapshot removal', () => state().applyWorkspaceSnapshot({ ...snapshot('default'), tasks: [] })]
]
for (const [name, leave] of exits) test(`${name} evicts history and rejects pending initial responses`, async () => {
  const gate = deferred<TaskEventsPage>()
  vi.mocked(window.anvil.tasks.eventsPage).mockImplementation(async (input) =>
    input.taskId === 'a' ? gate.promise : page([event(1, input.taskId)], input))
  const pending = state().openTask('a')
  await Promise.resolve()
  state().applyEvent(event(2))
  expect(cached()).toHaveLength(1)
  await leave()
  expect(cached()).toBeUndefined()
  expect(state().taskEventHistory?.taskId).not.toBe('a')
  gate.resolve(page(rows(1, 10)))
  await pending
  expect(cached()).toBeUndefined()
  await enqueueWorkspaceRequest(async () => {})
})

test('A-to-B-to-A rejects both late initial results and late failures', async () => {
  const first = deferred<TaskEventsPage>()
  const third = deferred<TaskEventsPage>()
  vi.mocked(window.anvil.tasks.eventsPage).mockReturnValueOnce(first.promise)
    .mockResolvedValueOnce(page([event(1, 'b')], { taskId: 'b' })).mockReturnValueOnce(third.promise)
  const old = state().openTask('a')
  await Promise.resolve()
  await state().openTask('b')
  const fresh = state().openTask('a')
  await Promise.resolve()
  first.reject(new Error('old failure'))
  await old
  expect(state().taskEventHistory).toMatchObject({ loading: 'initial', error: null })
  third.resolve(page([event(2)]))
  await fresh
  expect(cached()).toEqual([event(2)])
})

test('late pages cannot modify a reopened task or delete its newer request', async () => {
  vi.mocked(window.anvil.tasks.eventsPage).mockResolvedValueOnce(page(rows(1, 1000)))
  await state().openTask('a')
  const older = deferred<TaskEventsPage>()
  vi.mocked(window.anvil.tasks.eventsPage).mockReturnValueOnce(older.promise)
  const pending = state().loadTaskEvents('a', 'older')
  await Promise.resolve()
  state().showHome()
  await state().openTask('a')
  older.resolve(page(rows(1, 500)))
  await pending
  expect(cached()).toEqual([event(1)])
  expect(state().taskEventHistory).toMatchObject({ loading: null, error: null })
})

test('initial fetch merges live inserts and newer snapshots in stable sequence order', async () => {
  const gate = deferred<TaskEventsPage>()
  vi.mocked(window.anvil.tasks.eventsPage).mockReturnValueOnce(gate.promise)
  const pending = state().openTask('a')
  await Promise.resolve()
  state().applyEvent(event(3))
  state().applyEvent(event(2, 'a', 'fresh'))
  state().applyEvent(event(1, 'b'))
  gate.resolve(page(rows(1, 2)))
  await pending
  expect(cached()).toEqual([event(1), event(2, 'a', 'fresh'), event(3)])
  expect(cached('b')).toBeUndefined()
})

test('old out-of-window snapshots cannot become a new tail or enter the initial page', async () => {
  const gate = deferred<TaskEventsPage>()
  vi.mocked(window.anvil.tasks.eventsPage).mockReturnValueOnce(gate.promise)
  const pending = state().openTask('a')
  await Promise.resolve()
  state().applyEvent(event(1, 'a', 'old snapshot'))
  gate.resolve(page(rows(1, 1000)))
  await pending
  expect(cached()).toHaveLength(500)
  const retained = cached()
  state().applyEvent(event(2))
  state().applyEvent({ ...event(9999), sequence: undefined })
  expect(cached()).toBe(retained)
})

test('errors retain useful history and permit deduplicated retries for initial and older pages', async () => {
  vi.mocked(window.anvil.tasks.eventsPage).mockRejectedValueOnce(new Error('offline'))
  await state().openTask('a')
  expect(state().taskEventHistory).toMatchObject({ loaded: false, loading: null, error: 'offline' })
  vi.mocked(window.anvil.tasks.eventsPage).mockResolvedValueOnce(page(rows(1, 1000)))
  await state().openTask('a')
  const retained = cached()
  vi.mocked(window.anvil.tasks.eventsPage).mockRejectedValueOnce(new Error('page unavailable'))
  await state().loadTaskEvents('a', 'older')
  expect(cached()).toBe(retained)
  expect(state().taskEventHistory).toMatchObject({ loading: null, error: 'page unavailable' })
  const gate = deferred<TaskEventsPage>()
  const read = vi.mocked(window.anvil.tasks.eventsPage).mockReturnValueOnce(gate.promise)
  const first = state().loadTaskEvents('a', 'older')
  const second = state().loadTaskEvents('a', 'older')
  expect(first).toBe(second)
  await Promise.resolve()
  expect(read).toHaveBeenCalledTimes(4)
  gate.resolve(page(rows(1, 500)))
  await first
  expect(cached()).toHaveLength(1000)
  expect(state().taskEventHistory?.error).toBeNull()
})

test('slides older and newer across more than 4000 rows and leaves old history stationary during live output', async () => {
  const history = rows(1, 6500)
  vi.mocked(window.anvil.tasks.eventsPage).mockImplementation(async (input) => page(history, input))
  await state().openTask('a')
  while (state().taskEventHistory!.hasOlder) {
    await state().loadTaskEvents('a', 'older')
    expect(cached().length).toBeLessThanOrEqual(4000)
  }
  expect(cached()[0].sequence).toBe(1)
  expect(cached().at(-1)?.sequence).toBe(4000)
  const retained = cached()
  history.push(event(6501))
  state().applyEvent(event(6501))
  state().applyEvent(event(6000, 'a', 'off-window update'))
  expect(cached()).toBe(retained)
  expect(state().taskEventHistory).toMatchObject({ followingLatest: false, hasNewer: true })
  while (state().taskEventHistory!.hasNewer) {
    await state().loadTaskEvents('a', 'newer')
    expect(cached().length).toBeLessThanOrEqual(4000)
  }
  expect(cached().at(-1)?.sequence).toBe(6501)
  expect(state().taskEventHistory?.followingLatest).toBe(true)
  await state().loadTaskEvents('a', 'latest')
  expect(cached()).toHaveLength(500)
  expect(cached()[0].sequence).toBe(6002)
})

test('page/live races preserve snapshots fetched outside the current window and notice tail appends', async () => {
  vi.mocked(window.anvil.tasks.eventsPage).mockResolvedValueOnce(page(rows(1, 1000)))
  await state().openTask('a')
  const gate = deferred<TaskEventsPage>()
  vi.mocked(window.anvil.tasks.eventsPage).mockReturnValueOnce(gate.promise)
  const older = state().loadTaskEvents('a', 'older')
  await Promise.resolve()
  state().applyEvent(event(250, 'a', 'updated while fetching'))
  state().applyEvent(event(750, 'a', 'retained update'))
  state().applyEvent(event(1001))
  gate.resolve(page(rows(1, 500)))
  await older
  expect(cached().find((row) => row.sequence === 250)?.text).toBe('updated while fetching')
  expect(cached().find((row) => row.sequence === 750)?.text).toBe('retained update')
  expect(cached().at(-1)?.sequence).toBe(1000)
  const next = deferred<TaskEventsPage>()
  vi.mocked(window.anvil.tasks.eventsPage).mockReturnValueOnce(next.promise)
  const newer = state().loadTaskEvents('a', 'newer')
  await Promise.resolve()
  state().applyEvent(event(1002))
  next.resolve(page([event(1001)]))
  await newer
  expect(cached().at(-1)?.sequence).toBe(1002)
  expect(state().taskEventHistory?.hasNewer).toBe(false)
})

test('bounds live bursts during initial and latest loads and retains the newest 4000', async () => {
  const gate = deferred<TaskEventsPage>()
  vi.mocked(window.anvil.tasks.eventsPage).mockReturnValueOnce(gate.promise)
  const pending = state().openTask('a')
  await Promise.resolve()
  for (const row of rows(501, 4500)) state().applyEvent(row)
  expect(cached()).toHaveLength(4000)
  gate.resolve(page(rows(1, 500)))
  await pending
  expect(cached()).toHaveLength(4000)
  expect(cached()[0].sequence).toBe(1001)
  expect(cached().at(-1)?.sequence).toBe(5000)
  expect(state().taskEventHistory?.hasOlder).toBe(true)
  const reload = deferred<TaskEventsPage>()
  vi.mocked(window.anvil.tasks.eventsPage).mockReturnValueOnce(reload.promise)
  const latest = state().loadTaskEvents('a', 'latest')
  await Promise.resolve()
  state().applyEvent(event(5000, 'a', 'latest snapshot'))
  state().applyEvent(event(5001))
  reload.resolve(page(rows(1, 5000)))
  await latest
  expect(cached().at(-2)?.text).toBe('latest snapshot')
  expect(cached().at(-1)?.sequence).toBe(5001)
})

test('background output is ignored while task status and usage still update; reopening reads fresh history', async () => {
  await state().openTask('a')
  await state().openTask('b')
  state().applyEvent(event(2))
  state().applyTaskUpdate({ ...task('a'), status: 'succeeded', totalTokens: 200 })
  expect(cached()).toBeUndefined()
  expect(state().tasks.find((row) => row.id === 'a')).toMatchObject({ status: 'succeeded', totalTokens: 200 })
  vi.mocked(window.anvil.tasks.eventsPage).mockResolvedValueOnce(page(rows(1, 2)))
  await state().openTask('a')
  expect(cached()).toEqual(rows(1, 2))
  expect(Object.keys(state().eventsByTask)).toEqual(['a'])
})

test('inactive starts and comment sends never seed or replace the active cache', async () => {
  await state().openTask('a')
  const start = deferred<Task>()
  vi.mocked(window.anvil.tasks.start).mockReturnValueOnce(start.promise)
  const pending = state().startTask({ agentId: 'codex', prompt: 'new' })
  await state().openTask('b')
  start.resolve(task('created'))
  await pending
  const retained = cached('b')
  await state().sendComments('a')
  expect(Object.keys(state().eventsByTask)).toEqual(['b'])
  expect(cached('b')).toBe(retained)
  expect(state().view).toEqual({ kind: 'task', taskId: 'b' })
})

for (const direction of ['older', 'newer', 'latest'] as const) test(`${direction} responses are rejected after deletion and retry cleanly after errors`, async () => {
  const history = rows(1, 1500)
  vi.mocked(window.anvil.tasks.eventsPage).mockImplementation(async (input) => page(history, input))
  await state().openTask('a')
  if (direction === 'newer') {
    await state().loadTaskEvents('a', 'older')
    history.push(event(1501))
    state().applyEvent(event(1501))
  }
  vi.mocked(window.anvil.tasks.eventsPage).mockRejectedValueOnce(new Error('retry me'))
  await state().loadTaskEvents('a', direction)
  expect(state().taskEventHistory).toMatchObject({ loading: null, error: 'retry me' })
  const gate = deferred<TaskEventsPage>()
  vi.mocked(window.anvil.tasks.eventsPage).mockReturnValueOnce(gate.promise)
  const retry = state().loadTaskEvents('a', direction)
  await Promise.resolve()
  expect(state().taskEventHistory).toMatchObject({ loading: direction, error: null })
  await state().deleteTask('a')
  gate.resolve(page(history))
  await retry
  expect(state().eventsByTask).toEqual({})
  expect(state().taskEventHistory).toBeNull()
})

test('workspace switching evicts immediately, suppresses live output, and rejects A-to-B-to-A results', async () => {
  const oldPage = deferred<TaskEventsPage>()
  vi.mocked(window.anvil.tasks.eventsPage).mockReturnValueOnce(oldPage.promise)
  const pending = state().openTask('a')
  await Promise.resolve()
  const switchGate = deferred<WorkspaceSnapshot>()
  vi.mocked(window.anvil.workspaces.select).mockReturnValueOnce(switchGate.promise)
  const switching = state().selectWorkspace('other')
  state().applyEvent(event(2))
  expect(state().eventsByTask).toEqual({})
  switchGate.resolve(snapshot())
  await switching
  state().applyWorkspaceSnapshot(snapshot('default'))
  await state().openTask('a')
  oldPage.resolve(page([event(99)]))
  await pending
  expect(cached()).toEqual([event(1)])
})

test('a burst beyond 4000 events cannot evict fetched older snapshot overrides or move the reader', async () => {
  vi.mocked(window.anvil.tasks.eventsPage).mockResolvedValueOnce(page(rows(1, 1000)))
  await state().openTask('a')
  const gate = deferred<TaskEventsPage>()
  vi.mocked(window.anvil.tasks.eventsPage).mockReturnValueOnce(gate.promise)
  const pending = state().loadTaskEvents('a', 'older')
  await Promise.resolve()
  state().applyEvent(event(250, 'a', 'fresh snapshot'))
  const retained = cached()
  for (const row of rows(1001, 4500)) state().applyEvent(row)
  expect(cached()).toBe(retained)
  gate.resolve(page(rows(1, 500)))
  await pending
  expect(cached()).toHaveLength(1000)
  expect(cached().find((row) => row.sequence === 250)?.text).toBe('fresh snapshot')
  expect(cached().at(-1)?.sequence).toBe(1000)
  expect(state().taskEventHistory?.hasNewer).toBe(true)
})

test('empty forward pages ignore off-window snapshots and preserve the retained window', async () => {
  vi.mocked(window.anvil.tasks.eventsPage).mockResolvedValueOnce(page(rows(1, 1500)))
  await state().openTask('a')
  vi.mocked(window.anvil.tasks.eventsPage).mockResolvedValueOnce(page(rows(501, 500)))
  await state().loadTaskEvents('a', 'older')
  state().applyEvent(event(1501))
  const gate = deferred<TaskEventsPage>()
  vi.mocked(window.anvil.tasks.eventsPage).mockReturnValueOnce(gate.promise)
  const pending = state().loadTaskEvents('a', 'newer')
  await Promise.resolve()
  state().applyEvent(event(1, 'a', 'old'))
  gate.resolve(page([]))
  await pending
  expect(cached()[0].sequence).toBe(501)
})

test('unrelated project/task deletion and blocked composer focus preserve the active cache', async () => {
  await state().openTask('a')
  const retained = cached()
  useStore.setState({ settingsOpen: true })
  state().focusTaskComposer()
  await state().deleteTask('b')
  await state().removeProject('other')
  expect(cached()).toBe(retained)
})
