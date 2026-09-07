import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from '../src/main/store'
import type { Task } from '../src/shared/types'
import { testHome } from './issue-tracker-doubles'

const migrationsFolder = join(process.cwd(), 'src/main/db/migrations')
const oldMigrations = join(testHome, 'old-migrations')
mkdirSync(join(oldMigrations, 'meta'), { recursive: true })
const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta/_journal.json'), 'utf8'))
journal.entries = journal.entries.slice(0, 1)
writeFileSync(join(oldMigrations, 'meta/_journal.json'), JSON.stringify(journal))
copyFileSync(join(migrationsFolder, `${journal.entries[0].tag}.sql`), join(oldMigrations, `${journal.entries[0].tag}.sql`))
const database = join(testHome, 'recovery.db')
const old = new Store(database, { migrationsFolder: oldMigrations })
old.addProject({ id: 'project', name: 'Test', path: testHome, createdAt: 0, monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
const base: Task = {
  id: 'running', projectId: 'project', title: 'Task', prompt: 'Task', agentId: 'codex', agentLabel: 'Codex',
  cwd: testHome, status: 'running', deliveryStatus: 'working', startedAt: 1,
  inputTokens: 10, outputTokens: 5, cachedTokens: 0, totalTokens: 15, costUsd: null,
  filesChanged: 0, additions: 0, deletions: 0, sessionId: 'saved-session', branchName: 'saved-branch'
}
for (const [id, patch] of Object.entries({
  running: {},
  finalizing: { status: 'succeeded', deliveryStatus: 'finalizing' },
  legacy: { status: 'cancelled', deliveryStatus: 'finalizing' },
  stopped: { status: 'cancelled', deliveryStatus: 'finalizing' },
  finished: { status: 'succeeded', deliveryStatus: 'reviewable' },
  cancelled: { status: 'cancelled', deliveryStatus: 'agent_failed' }
}) as [string, Partial<Task>][]) {
  old.addTask({ ...base, ...patch, id })
  old.appendEvent({ id: `${id}-event`, taskId: id, ts: 2, stream: 'system', kind: 'output', category: 'system', text: id === 'stopped' ? 'Stop requested by user.' : 'Saved output' })
  old.saveTaskExecution({ taskId: id, projectPath: testHome, phase: id === 'running' ? 'working' : 'blocked', issueIds: ['saved-issue'], currentIssueId: 'saved-issue', error: null })
}
old.close()
const store = new Store(database, { migrationsFolder })
try {
  for (const id of ['running', 'finalizing', 'legacy']) {
    assert.equal(store.getTask(id)?.status, 'pending')
    assert.equal(store.getTask(id)?.deliveryStatus, 'agent_failed')
  }
  assert.equal(store.getTask('stopped')?.status, 'cancelled')
  assert.equal(store.getTask('stopped')?.deliveryStatus, 'agent_failed', 'Explicit Stop still clears stale finalization')
  assert.equal(store.getTask('cancelled')?.status, 'cancelled')
  assert.equal(store.getTask('finished')?.status, 'succeeded')
  assert.equal(store.getTask('finished')?.deliveryStatus, 'reviewable')
  for (const task of store.getTasks()) {
    assert.equal(task.sessionId, 'saved-session')
    assert.equal(task.branchName, 'saved-branch')
    assert.equal(task.totalTokens, 15)
    assert.equal(store.readEvents(task.id).length, 1, 'Migration must retain child rows')
    assert.equal(store.getTaskExecution(task.id)?.currentIssueId, 'saved-issue')
    assert.equal(store.getTaskExecution(task.id)?.phase, 'blocked')
  }
} finally {
  store.close()
}
console.log('Task recovery passed: pending interruptions, explicit stops, saved sessions, and migration data retention.')
