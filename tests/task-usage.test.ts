import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAppServerOutput } from '../src/main/agents/codex-app-server-output'
import { Store } from '../src/main/store'
import { registerTaskEvents } from '../src/main/tasks/events'
import type { TaskContext } from '../src/main/tasks/context'

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
const directory = mkdtempSync(join(tmpdir(), 'anvil-task-usage-'))
const options = { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') }
const database = join(directory, 'test.db')
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
    const output = new CodexAppServerOutput({ taskId: 'task', cwd: directory, prompt: 'Fix icon' }, (event) => {
      if (event.type === 'usage') agentProcesses.emit('usage', { taskId: event.taskId, ...event.usage })
    })
    for (const [inputTokens, cachedInputTokens, outputTokens] of snapshots) {
      const snapshot = { total: { inputTokens, cachedInputTokens, outputTokens, totalTokens: inputTokens + outputTokens } }
      output.updateUsage(snapshot, true)
      const once = store.getTask('task')
      output.updateUsage(snapshot, true)
      assert.deepEqual(store.getTask('task'), once, 'Repeated protocol snapshots must not add usage twice')
    }
    agentProcesses.emit('exit', { taskId: 'task', code: 0, cancelled: false })
  }
  const task = store.getTask('task')!
  assert.equal(task.inputTokens, 688809)
  assert.equal(task.outputTokens, 3639)
  assert.equal(task.cachedTokens, 638208)
  assert.equal(task.totalTokens, 692448, 'Cached input is already included, not added again')
  assert.equal(task.inputTokens - task.cachedTokens, 50601)
  store.close()
  store = new Store(database, options)
  for (const key of ['inputTokens', 'outputTokens', 'cachedTokens', 'totalTokens', 'costUsd'] as const) {
    assert.equal(store.getTask('task')![key], task[key], `Restart preserves ${key}`)
  }
  console.log('Task usage replay passed: 21 requests, 688809 input including 638208 cached, 3639 output, no double counting.')
} finally {
  store.close()
  rmSync(directory, { recursive: true, force: true })
}
