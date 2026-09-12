import { testWorkspace } from './workspace-fixture'
import { expect, test, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { testHome } from './issue-tracker-doubles'
import { join } from 'node:path'
import { CodexAppServerOutput } from '../src/server/agents/codex-app-server-output'
import { Store } from '../src/server/store'
import { registerTaskEvents } from '../src/server/tasks/events'
import type { TaskContext } from '../src/server/tasks/context'

// Numeric-only cumulative snapshots from task 369e05db's two Codex rollouts.
// Each tuple is input, cached input, output. No prompts or personal data.
const planning = [
  [22843, 12160, 198], [47772, 34816, 277], [74870, 59520, 350],
  [103226, 86400, 412], [132087, 114560, 532], [161255, 143232, 765]
]
const implementation = [
  [23720, 12160, 135], [49431, 35712, 251], [78949, 61184, 373],
  [108747, 90496, 491], [139052, 120064, 578], [171630, 150144, 737],
  [206927, 182528, 826], [245232, 217600, 1276], [284160, 255744, 1502],
  [323445, 294528, 1743], [363315, 333696, 1875], [403521, 373376, 2057],
  [444172, 413440, 2618], [485491, 453888, 2686], [527554, 494976, 2874]
]
test('replays cumulative usage without double counting and preserves totals on restart', () => {
  // Usage events checkpoint working time, which is tested separately in task-timing.
  vi.spyOn(Date, 'now').mockReturnValue(1_000)
  const directory = mkdtempSync(join(testHome, 'anvil-task-usage-'))
  const options = { migrationsFolder: join(process.cwd(), 'src/server/db/migrations') }
  const database = join(directory, 'config.json')
  let store = new Store(database, options)
  try {
    store.addProject({ id: 'project', name: 'Test', path: directory, createdAt: 0, monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
    store.addTask({
      id: 'task', projectId: 'project', title: 'Usage', prompt: 'Fix icon', cwd: directory,
      agentId: 'codex', agentLabel: 'Codex', status: 'running', deliveryStatus: 'working', startedAt: 0,
      inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null,
      filesChanged: 0, additions: 0, deletions: 0
    })
    const agentProcesses = new EventEmitter() as TaskContext['agentProcesses']
    registerTaskEvents({ store, agentProcesses, send: () => {} })
    for (const snapshots of [planning, implementation]) {
      const output = new CodexAppServerOutput({ workspace: testWorkspace(), taskId: 'task', cwd: directory, prompt: 'Fix icon' }, (event) => {
        if (event.type === 'usage') agentProcesses.emit('usage', { taskId: event.taskId, ...event.usage })
      })
      for (const [inputTokens, cachedInputTokens, outputTokens] of snapshots) {
        const snapshot = { total: { inputTokens, cachedInputTokens, outputTokens, totalTokens: inputTokens + outputTokens } }
        output.updateUsage(snapshot, true)
        const once = store.getTask('task')
        output.updateUsage(snapshot, true)
        expect(store.getTask('task'), 'Repeated protocol snapshots must not add usage twice').toStrictEqual(once)
      }
      agentProcesses.emit('exit', { taskId: 'task', code: 0, cancelled: false })
    }
    const task = store.getTask('task')!
    expect(task.inputTokens).toBe(688809)
    expect(task.outputTokens).toBe(3639)
    expect(task.cachedTokens).toBe(638208)
    expect(task.totalTokens, 'Cached input is already included, not added again').toBe(692448)
    expect(task.inputTokens - task.cachedTokens).toBe(50601)
    agentProcesses.emit('session', { taskId: 'task', sessionId: 'saved-session' })
    agentProcesses.emit('context', { taskId: 'task', contextUsed: 142000, contextSize: 213000 })
    expect(store.getTask('task')).toMatchObject({ contextUsed: 142000, contextSize: 213000, totalTokens: 692448 })
    agentProcesses.emit('compaction', { taskId: 'task', running: false, error: 'Compaction failed' })
    store.close()
    store = new Store(database, options)
    expect(store.getTask('task')).toMatchObject({ contextUsed: 142000, contextSize: 213000, contextCompactionError: 'Compaction failed' })
    expect(store.getSettings()).toMatchObject({ autoCompactContext: true, contextCompactionThreshold: 75 })
    store.setSettings({ autoCompactContext: false, contextCompactionThreshold: 85 })
    expect(store.getSettings()).toMatchObject({ autoCompactContext: false, contextCompactionThreshold: 85 })
    expect(() => store.setSettings({ contextCompactionThreshold: 101 })).toThrow('threshold')
    for (const key of ['inputTokens', 'outputTokens', 'cachedTokens', 'totalTokens', 'costUsd'] as const) {
      expect(store.getTask('task')![key], `Restart preserves ${key}`).toBe(task[key])
    }
    // A different issue session must not inherit occupancy or a failed compact.
    const resumedProcesses = new EventEmitter() as TaskContext['agentProcesses']
    registerTaskEvents({ store, agentProcesses: resumedProcesses, send: () => {} })
    resumedProcesses.emit('session', { taskId: 'task', sessionId: 'fresh-issue' })
    expect(store.getTask('task')?.contextUsed).toBeUndefined()
    expect(store.getTask('task')?.contextSize).toBeUndefined()
    expect(store.getTask('task')?.contextCompactionError).toBeUndefined()
    expect(store.getTask('task')?.totalTokens).toBe(692448)
  } finally {
    store.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
