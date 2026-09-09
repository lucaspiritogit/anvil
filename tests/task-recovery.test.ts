import { expect, test } from 'vitest'
import Database from 'better-sqlite3'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Store } from '../src/main/store'
import type { Task } from '../src/shared/types'
import { testHome } from './issue-tracker-doubles'

test('migrates interrupted tasks while retaining sessions, output and execution state', () => {
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
  const legacyDb = new Database(database)
  for (const [id, patch] of Object.entries({
    running: {},
    finalizing: { status: 'succeeded', deliveryStatus: 'finalizing' },
    legacy: { status: 'cancelled', deliveryStatus: 'finalizing' },
    stopped: { status: 'cancelled', deliveryStatus: 'finalizing' },
    finished: { status: 'succeeded', deliveryStatus: 'reviewable' },
    cancelled: { status: 'cancelled', deliveryStatus: 'agent_failed' },
    review: { status: 'failed', deliveryStatus: 'agent_failed' }
  }) as [string, Partial<Task>][]) {
    old.addTask({ ...base, ...patch, id })
    legacyDb.prepare('INSERT INTO task_events (id, task_id, ts, stream, kind, category, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(`${id}-event`, id, 2, 'system', 'output', 'system', id === 'stopped' ? 'Stop requested by user.' : 'Saved output')
    old.saveTaskExecution({ taskId: id, projectPath: testHome, parentIssueId: 'saved-parent',
      phase: id === 'running' ? 'working' : id === 'review' ? 'reviewing' : 'blocked',
      issueIds: ['saved-issue'], currentIssueId: 'saved-issue', error: null })
  }
  legacyDb.close()
  old.close()
  const store = new Store(database, { migrationsFolder })
  try {
    for (const id of ['running', 'finalizing', 'legacy']) {
      expect(store.getTask(id)?.status).toBe('pending')
      expect(store.getTask(id)?.deliveryStatus).toBe('agent_failed')
    }
    expect(store.getTask('stopped')?.status).toBe('cancelled')
    expect(store.getTask('stopped')?.deliveryStatus, 'Explicit Stop still clears stale finalization').toBe('agent_failed')
    expect(store.getTask('cancelled')?.status).toBe('cancelled')
    expect(store.getTask('finished')?.status).toBe('succeeded')
    expect(store.getTask('finished')?.deliveryStatus).toBe('reviewable')
    for (const task of store.getTasks().filter((task) => task.id !== 'review')) {
      expect(task.sessionId).toBe('saved-session')
      expect(task.branchName).toBe('saved-branch')
      expect(task.totalTokens).toBe(15)
      expect(store.readEvents(task.id), 'Migration retains legacy output without guessing its issue from recovery state').toEqual([{
        id: `${task.id}-event`, taskId: task.id, issueId: undefined, ts: 2, stream: 'system',
        kind: 'output', category: 'system', text: task.id === 'stopped' ? 'Stop requested by user.' : 'Saved output'
      }])
      expect(store.getTaskExecution(task.id)?.currentIssueId).toBe('saved-issue')
      expect(store.getTaskExecution(task.id)?.phase).toBe('blocked')
    }
    expect(store.getTask('review')?.status).toBe('failed')
    expect(store.getTaskExecution('review')?.currentIssueId).toBe('saved-issue')
    expect(store.getTaskExecution('review')?.phase, 'An issue awaiting review survives a restart without being blocked').toBe('reviewing')
  } finally {
    store.close()
  }
})
