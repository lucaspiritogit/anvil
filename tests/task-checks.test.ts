import { expect, test } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { onTestCleanup } from './test-cleanup'
import { Store } from '../apps/server/src/store'
import { createTaskChecks } from '../apps/server/src/tasks/task-checks'
import type { Task } from '@anvil/protocol/types'

function setup(checkCommand: string | null, timeoutMs?: number) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-task-checks-')))
  onTestCleanup(() => rmSync(home, { recursive: true, force: true }))
  const store = new Store(join(home, randomUUID(), 'config.json'), { migrationsFolder: join(process.cwd(), 'apps/server/src/db/migrations') })
  onTestCleanup(() => store.close())
  store.addProject({ id: 'project', name: 'Project', path: home, createdAt: 0, monthlyTokenLimit: null,
    monthlyCostLimitUsd: null, finishOnPush: false, shipPushes: false, gitPlatform: 'github' })
  if (checkCommand !== null) store.updateProject('project', { checkCommand })
  const task = store.addTask({
    id: randomUUID(), projectId: 'project', agentId: 'codex', agentLabel: 'Codex', checkoutMode: 'worktree',
    prompt: 'Change', title: 'Change', cwd: home, status: 'succeeded', startedAt: 0, deliveryStatus: 'reviewable',
    headCommit: 'a'.repeat(40), filesChanged: 1, additions: 1, deletions: 0,
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null
  })
  const events: string[] = []
  const updates: Task[] = []
  const checks = createTaskChecks({ store, send: (channel, payload) => {
    if (channel === 'task:updated') updates.push(payload as Task)
  } }, (_taskId, text) => { events.push(text) }, timeoutMs)
  onTestCleanup(() => checks.close())
  return { store, task, checks, events, updates }
}

test('records a passing run against the task head', async () => {
  const f = setup('node -e "console.log(\'all good\')"')
  const result = await f.checks.run(f.task.id)
  expect(result.checks).toMatchObject({ status: 'passed', exitCode: 0, headCommit: 'a'.repeat(40) })
  expect(result.checks?.output).toContain('all good')
  expect(f.updates[0].checks?.status).toBe('running')
  expect(f.store.getTask(f.task.id)?.checks?.status).toBe('passed')
  expect(f.events.at(-1)).toMatch(/^Checks passed/)
})

test('records failures with the exit code and output tail', async () => {
  const f = setup('node -e "console.error(\'boom\'); process.exit(3)"')
  const result = await f.checks.run(f.task.id)
  expect(result.checks).toMatchObject({ status: 'failed', exitCode: 3 })
  expect(result.checks?.output).toContain('boom')
  expect(f.events.at(-1)).toMatch(/exit code 3/)
})

test('stops a run that exceeds the timeout', async () => {
  const f = setup('node -e "setTimeout(() => {}, 60000)"', 300)
  const result = await f.checks.run(f.task.id)
  expect(result.checks?.status).toBe('failed')
  expect(result.checks?.output).toMatch(/Stopped after/)
  expect(f.events.at(-1)).toMatch(/timed out/)
})

test('refuses to run without a project check command and skips automatic runs', async () => {
  const f = setup(null)
  await expect(f.checks.run(f.task.id)).rejects.toThrow(/Set a check command/)
  f.checks.runIfConfigured(f.task.id)
  expect(f.store.getTask(f.task.id)?.checks).toBeUndefined()
})
