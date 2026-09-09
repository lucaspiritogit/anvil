import { expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { internalTrackerFixture } from './fixtures/internal-valence'
import type { TaskIssueSnapshot } from '../src/shared/types'
import { createTaskIssuesCache, selectedTaskIssue } from '../src/renderer/src/state/task-issues'
import { onTestCleanup } from './test-cleanup'

const snapshot = (id: string): TaskIssueSnapshot => ({ parent: { id, anvilTaskId: id, title: id, description: '' }, children: [] })

function fixture(read = vi.fn<(id: string) => Promise<TaskIssueSnapshot | null>>().mockResolvedValue(snapshot('parent'))) {
  vi.useFakeTimers()
  onTestCleanup(() => { vi.useRealTimers() })
  const updates = new Set<(id: string) => void>()
  const deletes = new Set<(id: string) => void>()
  const focus = new Set<() => void>()
  const cache = createTaskIssuesCache({
    read,
    onUpdated: (fn) => { updates.add(fn); return () => { updates.delete(fn) } },
    onDeleted: (fn) => { deletes.add(fn); return () => { deletes.delete(fn) } },
    onFocus: (fn) => { focus.add(fn); return () => { focus.delete(fn) } }
  })
  let selected = 'task'
  const loader = { getSnapshot: () => cache.getSnapshot(selected) }
  const start = (id = 'task') => {
    selected = id
    const stop = cache.subscribe(id, () => {})
    onTestCleanup(stop)
    return stop
  }
  return { cache, loader, start, read, updates, deletes, focus }
}

const tick = () => vi.advanceTimersByTimeAsync(0)

test('polls internal CLI changes without task events and derives current selected details', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'issue-refresh-'))
  onTestCleanup(() => rmSync(directory, { recursive: true, force: true }))
  const { writer, open } = internalTrackerFixture(directory)
  onTestCleanup(() => writer.close())
  const parent = writer.createParent({ anvilTaskId: 'task', title: 'Parent' })
  const read = vi.fn(async () => {
    const reader = open()
    try { return { parent: { ...reader.getParent(parent.id), anvilTaskId: 'task' }, children: reader.list(parent.id) } }
    finally { reader.close() }
  })
  const { loader, start, updates } = fixture(read)
  start()
  await tick()
  expect(loader.getSnapshot().empty).toBe(true)
  const child = writer.create({ parentId: parent.id, title: 'External', description: 'Summary', checklist: ['Checked'], validation: 'Test' })
  writer.update(child.id, { title: 'Renamed' })
  for (const status of ['queued', 'working', 'blocked', 'review', 'complete']) {
    if (status === 'working') writer.start(child.id)
    if (status === 'blocked') writer.block(child.id)
    if (status === 'review') {
      writer.requeue(child.id)
      writer.start(child.id)
      writer.submitForReview(child.id, { checklist: [true], evidence: 'Test passed' })
    }
    if (status === 'complete') writer.approve(child.id)
    await vi.advanceTimersByTimeAsync(500)
    const current = loader.getSnapshot()
    expect(current.snapshot?.children[0].status).toBe(status)
    expect(selectedTaskIssue(current.snapshot, child.id)).toEqual(writer.get(child.id))
    expect(current.empty).toBe(false)
    expect(current.snapshot?.children[0].title).toBe('Renamed')
  }
  writer.updateParent(parent.id, { description: 'Updated summary' })
  await vi.advanceTimersByTimeAsync(500)
  expect(selectedTaskIssue(loader.getSnapshot().snapshot, parent.id)?.description).toBe('Updated summary')
  expect(updates.size).toBe(1) // No task event was emitted.
})

test('shares reads and subscriptions across sidebar, task view and panel consumers', async () => {
  const { cache, start, read, updates, deletes, focus } = fixture()
  const sidebar = start()
  const view = start()
  const panel = start()
  await tick()
  expect(read).toHaveBeenCalledTimes(1)
  expect(updates.size + deletes.size + focus.size).toBe(3)
  expect(vi.getTimerCount()).toBe(1)
  expect(cache.getSnapshot('task')).toBe(cache.getSnapshot('task'))
  panel()
  view()
  await vi.advanceTimersByTimeAsync(500)
  expect(read).toHaveBeenCalledTimes(2)
  sidebar()
  expect(vi.getTimerCount()).toBe(0)
  expect(updates.size + deletes.size + focus.size).toBe(0)
})

test('deduplicates in-flight refreshes and rejects responses from a previous subscription', async () => {
  const responses: Array<(value: TaskIssueSnapshot) => void> = []
  const read = vi.fn((_id: string) => new Promise<TaskIssueSnapshot>((resolve) => responses.push(resolve)))
  const { cache, start, updates, focus } = fixture(read)
  const stop = start('first')
  await vi.advanceTimersByTimeAsync(2000)
  updates.forEach((fn) => fn('first'))
  focus.forEach((fn) => fn())
  expect(read).toHaveBeenCalledTimes(1)
  stop()
  start('first')
  responses.shift()!(snapshot('stale'))
  await tick()
  expect(cache.getSnapshot('first').snapshot).toBeNull()
  expect(read).toHaveBeenCalledTimes(2)
  responses.shift()!(snapshot('fresh'))
  await tick()
  expect(cache.getSnapshot('first').snapshot?.parent.id).toBe('fresh')
})

test('bounds concurrent reads across visible tasks and skips unmounted queued tasks', async () => {
  const responses: Array<(value: TaskIssueSnapshot) => void> = []
  const read = vi.fn((_id: string) => new Promise<TaskIssueSnapshot>((resolve) => responses.push(resolve)))
  const { cache, start } = fixture(read)
  for (let i = 0; i < 5; i++) start(String(i))
  const stop = start('hidden')
  stop()
  expect(read).toHaveBeenCalledTimes(4)
  responses.shift()!(snapshot('first'))
  await tick()
  expect(read.mock.calls.map(([id]) => id)).toEqual(['0', '1', '2', '3', '4'])
  expect(cache.getSnapshot('0').snapshot?.parent.id).toBe('first')
  expect(cache.getSnapshot('1').snapshot).toBeNull()
  while (responses.length) responses.shift()!(snapshot('done'))
  await tick()
  expect(read).toHaveBeenCalledTimes(5)
})

test('retains successful data through errors and recovers on focus, updates and polling', async () => {
  const { loader, start, read, updates, focus } = fixture()
  read.mockRejectedValueOnce(new Error('Unavailable'))
  start()
  await tick()
  expect(loader.getSnapshot()).toMatchObject({ loading: false, error: 'Unavailable', snapshot: null, empty: false })
  await vi.advanceTimersByTimeAsync(500)
  const previous = loader.getSnapshot().snapshot
  read.mockRejectedValueOnce(new Error('Refresh failed'))
  updates.forEach((fn) => fn('other'))
  expect(read).toHaveBeenCalledTimes(2)
  updates.forEach((fn) => fn('task'))
  await tick()
  expect(loader.getSnapshot()).toMatchObject({ snapshot: previous, error: 'Refresh failed' })
  focus.forEach((fn) => fn())
  await tick()
  expect(loader.getSnapshot().error).toBeNull()
  read.mockResolvedValueOnce(null)
  await vi.advanceTimersByTimeAsync(500)
  expect(loader.getSnapshot()).toMatchObject({ snapshot: null, empty: false, missing: true, loading: false })
})

for (const reason of ['close', 'delete'] as const) {
  test(`cleans up timers/listeners and ignores pending results on ${reason}`, async () => {
    let resolve!: (snapshot: TaskIssueSnapshot) => void
    const read = vi.fn(() => new Promise<TaskIssueSnapshot>((done) => { resolve = done }))
    const { loader, start, updates, deletes, focus } = fixture(read)
    const stop = start()
    if (reason === 'close') stop()
    else deletes.forEach((fn) => fn('task'))
    expect(updates.size + deletes.size + focus.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    resolve(snapshot('late'))
    await vi.advanceTimersByTimeAsync(2000)
    expect(read).toHaveBeenCalledTimes(1)
    expect(loader.getSnapshot().snapshot).toBeNull()
  })
}

test('deletion clears every consumer of its task while other visible tasks keep refreshing', async () => {
  const { cache, start, read, deletes, updates } = fixture()
  const notified = vi.fn()
  const off = cache.subscribe('deleted', notified)
  onTestCleanup(off)
  start('deleted')
  start('survivor')
  await tick()
  expect(cache.getSnapshot('deleted').snapshot).not.toBeNull()
  notified.mockClear()
  deletes.forEach((remove) => remove('deleted'))
  expect(notified).toHaveBeenCalledTimes(1)
  expect(cache.getSnapshot('deleted').snapshot).toBeNull()
  read.mockClear()
  await vi.advanceTimersByTimeAsync(500)
  expect(read.mock.calls).toEqual([['survivor']])
  expect(updates.size).toBe(1)
})
