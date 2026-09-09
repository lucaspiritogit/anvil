import { onTestCleanup } from './test-cleanup'
import { randomUUID } from 'node:crypto'
import { WallpaperLibrary } from '../src/main/wallpapers'
import { rendererEvent, rendererIpc } from './renderer-fixture'
import { registerSettingsHandlers } from '../src/main/ipc/settings'
import { handlers } from './issue-tracker-doubles'
import { test, expect } from 'vitest'
import { join } from 'node:path'
import { registerCaffeineMode } from '../src/main/caffeine-mode'
import { Store } from '../src/main/store'
import type { Task } from '../src/shared/types'
import { testHome } from './issue-tracker-doubles'

function setupCaffeine() {
  const database = join(testHome, `caffeine-${randomUUID()}.db`)
  const options = { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') }
  const store = new Store(database, options)
  onTestCleanup(() => store.close())
  const active = new Set<number>()
  let starts = 0
  const blocker = {
    start(type: string): number {
      expect(type).toBe('prevent-display-sleep')
      const id = starts++
      active.add(id)
      return id
    },
    stop(id: number): boolean {
      expect(active.has(id), 'Only release an owned, active blocker').toBeTruthy()
      return active.delete(id)
    }
  }
  const stop = registerCaffeineMode(store, blocker)
  onTestCleanup(stop)
  const task: Task = {
    workspaceId: 'default',
    id: 'first', projectId: 'project', title: 'Task', prompt: 'Task', agentId: 'codex', agentLabel: 'Codex',
    cwd: testHome, status: 'running', deliveryStatus: 'preparing', startedAt: 1,
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null,
    filesChanged: 0, additions: 0, deletions: 0
  }
  return { store, database, options, active, blocker, stop, task, get starts() { return starts } }
}

test('toggles sleep prevention for running, paused, concurrent and deleted tasks', () => {
  const fixture = setupCaffeine()
  const { store, active, stop, task } = fixture
  try {
    store.addProject({ id: 'project', name: 'Test', path: testHome, createdAt: 0, monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
    expect(store.getSettings().caffeineMode).toBe(false)
    store.addTask(task)
    expect(fixture.starts, 'Running tasks do not block sleep by default').toBe(0)
    registerSettingsHandlers(rendererIpc, store, new WallpaperLibrary(testHome))
    handlers.get('settings:set')!(rendererEvent, { caffeineMode: true })
    expect(() => handlers.get('settings:set')!(rendererEvent, { caffeineMode: 'true' })).toThrow(/Invalid IPC request/)
    expect([...active], 'Enabling during an existing task starts immediately, including blocker ID zero').toStrictEqual([0])
    store.addTask({ ...task, id: 'second' })
    store.updateTask(task.id, { deliveryStatus: 'working' })
    store.setSettings({ caffeineMode: true })
    expect(fixture.starts, 'Concurrent tasks and repeated updates share one blocker').toBe(1)
    store.updateTask(task.id, { status: 'succeeded' })
    expect(active.size, 'Finishing one task leaves the other protected').toBe(1)
    store.updateTask('second', { status: 'pending' })
    expect(active.size, 'Pausing the last running task releases sleep prevention').toBe(0)
    store.setSettings({ caffeineMode: true })
    expect(fixture.starts, 'Enabled but idle does not block sleep').toBe(1)
    store.updateTask('second', { status: 'running' })
    expect(active.size, 'Resuming restarts sleep prevention').toBe(1)
    store.setSettings({ caffeineMode: false })
    expect(active.size, 'Disabling while running releases immediately').toBe(0)
    store.setSettings({ caffeineMode: 'true' } as unknown as Parameters<Store['setSettings']>[0])
    expect(store.getSettings().caffeineMode, 'Only boolean true enables the mode').toBe(false)
    store.setSettings({ caffeineMode: true })
    store.deleteTaskCascade('second')
    expect(active.size, 'Deleting the last running task releases the blocker').toBe(0)
    for (const status of ['cancelled', 'failed', 'succeeded'] as const) {
      store.updateTask(task.id, { status: 'running' })
      expect(active.size).toBe(1)
      store.updateTask(task.id, { status })
      expect(active.size).toBe(0)
    }
    store.updateTask(task.id, { status: 'running' })
    store.removeProject('project')
    expect(active.size, 'Project deletion releases protection for cascaded tasks').toBe(0)
  } finally {
    stop()
    store.close()
  }
})

test('persists the preference, synchronizes registration and releases protection on shutdown and recovery', () => {
  const fixture = setupCaffeine()
  const { store, database, options, active, blocker, stop, task } = fixture
  store.setSettings({ caffeineMode: true })
  stop()
  store.close()
  const restarted = new Store(database, options)
  try {
    expect(restarted.getSettings().caffeineMode, 'The preference survives restart').toBe(true)
    restarted.addProject({ id: 'project', name: 'Test', path: testHome, createdAt: 0, monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
    restarted.addTask(task)
    const close = registerCaffeineMode(restarted, blocker)
    onTestCleanup(close)
    expect(active.size, 'Registration synchronizes existing state').toBe(1)
    close()
    close()
    expect(active.size, 'Shutdown releases the blocker and is idempotent').toBe(0)
    const before = fixture.starts
    restarted.setSettings({ caffeineMode: true })
    restarted.updateTask(task.id, { status: 'pending' })
    restarted.updateTask(task.id, { status: 'running' })
    expect(fixture.starts, 'Shutdown unsubscribes so late callbacks cannot restart protection').toBe(before)
  } finally {
    restarted.close()
  }

  const recovered = new Store(database, options)
  try {
    const close = registerCaffeineMode(recovered, blocker)
    onTestCleanup(close)
    expect(recovered.getTask(task.id)?.status).toBe('pending')
    expect(active.size, 'Interrupted tasks recovered at startup do not keep the computer awake').toBe(0)
    close()
  } finally {
    recovered.close()
  }
})
