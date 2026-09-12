import { expect, test } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/server/store'
import { onTestCleanup } from './test-cleanup'
import { migrateBefore, migrationsFolder } from './migration-fixture'

function fixture(existing = false): { db: Database.Database; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'anvil-valence-schema-'))
  onTestCleanup(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'config.json')
  const workspacePath = join(directory, 'workspaces', 'Default', 'anvil.db')
  let originalTasks: Record<string, unknown>[] | undefined
  if (existing) {
    migrateBefore(workspacePath, 5)
    const old = new Database(workspacePath)
    try {
      seedTasks(old)
      originalTasks = old.prepare<[], Record<string, unknown>>('SELECT * FROM tasks ORDER BY id').all()
    } finally { old.close() }
  }
  const store = new Store(path, { migrationsFolder })
  store.close()
  const db = new Database(workspacePath)
  db.pragma('foreign_keys = ON')
  onTestCleanup(() => { if (db.open) db.close() })
  if (!existing) seedTasks(db)
  if (originalTasks) {
    expect(db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(originalTasks.map((row) => ({
      ...row,
      workspace_id: 'default',
      context_used: null,
      context_size: null,
      context_compaction_error: null,
      parent_task_id: null,
      expected_files: null,
      restack_state: null,
      restack_target: null,
      stack_suggestion: null,
      working_time_ms: 0,
      working_started_at: null
    })))
  }
  return { db, path }
}

function seedTasks(db: Database.Database): void {
  db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES ('project', 'Project', '/test', 1)").run()
  for (const id of ['task-a', 'task-b']) {
    db.prepare(`INSERT INTO tasks (id, project_id, agent_id, agent_label, prompt, title, cwd, status, started_at)
      VALUES (?, 'project', 'codex', 'Codex', 'Prompt', 'Title', '/test', 'succeeded', 1)`).run(id)
  }
}

function parent(db: Database.Database, id: string, taskId: string | null): void {
  db.prepare('INSERT INTO parent_issues (id, anvil_task_id, title, description) VALUES (?, ?, ?, ?)')
    .run(id, taskId, 'Parent', 'Description')
}

function issue(db: Database.Database, id: string, parentId: string): void {
  db.prepare(`INSERT INTO issues (id, parent_id, title, description, checklist, validation, labels,
    priority, status, evidence, completed_at) VALUES (?, ?, 'Issue', 'Description', '["Check"]',
    'Run tests', '["schema"]', 'high', 'complete', 'Passed', 123)`).run(id, parentId)
}

for (const existing of [false, true]) {
  test(`migrates ${existing ? 'existing' : 'fresh'} Anvil database with task ownership and stable ordering`, () => {
    const { db, path } = fixture(existing)
    const before = db.prepare('SELECT * FROM tasks ORDER BY id').all()
    expect(before).toHaveLength(2)
    expect(() => parent(db, 'missing', 'unknown')).toThrow(/FOREIGN KEY/)
    expect(() => parent(db, 'null', null)).toThrow(/NOT NULL/)
    parent(db, 'parent-z', 'task-a')
    parent(db, 'parent-a', 'task-b')
    expect(() => parent(db, 'duplicate', 'task-a')).toThrow(/UNIQUE/)
    expect(() => issue(db, 'orphan', 'unknown')).toThrow(/FOREIGN KEY/)
    issue(db, 'z', 'parent-z')
    issue(db, 'a', 'parent-z')
    issue(db, 'm', 'parent-a')
    const link = db.prepare('INSERT INTO issue_dependencies VALUES (?, ?, ?)')
    link.run('m', 'z', 0)
    link.run('m', 'a', 1)
    expect(() => link.run('m', 'unknown', 2)).toThrow(/FOREIGN KEY/)
    expect(() => link.run('unknown', 'a', 2)).toThrow(/FOREIGN KEY/)
    expect(() => link.run('m', 'm', 2)).toThrow(/CHECK/)
    expect(() => link.run('m', 'a', 2)).toThrow(/UNIQUE/)
    expect(() => link.run('a', 'z', -1)).toThrow(/CHECK/)
    expect(() => link.run('m', 'a', 0)).toThrow(/UNIQUE/)
    expect(db.prepare('SELECT dependency_id FROM issue_dependencies WHERE issue_id = ? ORDER BY position').all('m'))
      .toEqual([{ dependency_id: 'z' }, { dependency_id: 'a' }])
    expect(db.prepare('SELECT * FROM issues WHERE id = ?').get('z')).toMatchObject({
      title: 'Issue', description: 'Description', checklist: '["Check"]', validation: 'Run tests',
      labels: '["schema"]', priority: 'high', status: 'complete', evidence: 'Passed', completed_at: 123
    })
    expect(db.prepare(`SELECT tasks.project_id FROM parent_issues JOIN tasks
      ON tasks.id = parent_issues.anvil_task_id WHERE parent_issues.id = ?`).get('parent-z'))
      .toEqual({ project_id: 'project' })
    db.exec('VACUUM')
    new Store(path, { migrationsFolder }).close()
    expect(db.prepare('SELECT id FROM parent_issues ORDER BY sequence').all())
      .toEqual([{ id: 'parent-z' }, { id: 'parent-a' }])
    expect(db.prepare('SELECT id FROM issues ORDER BY sequence').all())
      .toEqual([{ id: 'z' }, { id: 'a' }, { id: 'm' }])
    expect(db.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(before)
    expect(db.pragma('foreign_key_check')).toEqual([])
  })
}

test('adds a nullable issue start timestamp without inventing history or changing existing records', () => {
  const directory = mkdtempSync(join(tmpdir(), 'anvil-issue-start-migration-'))
  onTestCleanup(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'config.json')
  const workspacePath = join(directory, 'workspaces', 'Default', 'anvil.db')
  migrateBefore(workspacePath, 10)
  const db = new Database(workspacePath)
  onTestCleanup(() => { if (db.open) db.close() })
  seedTasks(db)
  parent(db, 'parent', 'task-a')
  for (const status of ['queued', 'working', 'review', 'complete']) {
    issue(db, status, 'parent')
    db.prepare('UPDATE issues SET status = ?, base_commit = ?, head_commit = ? WHERE id = ?')
      .run(status, 'base', 'head', status)
  }
  db.prepare('INSERT INTO issue_dependencies VALUES (?, ?, ?)').run('queued', 'complete', 0)
  const before = db.prepare<[], Record<string, unknown>>('SELECT * FROM issues ORDER BY sequence').all()
  expect(before.every((row) => !Object.hasOwn(row, 'started_at'))).toBe(true)

  db.close()
  const migrated = new Store(path, { migrationsFolder })
  onTestCleanup(() => migrated.close())
  const workspaceDb = new Database(migrated.getWorkspaceDatabasePath('default'))
  onTestCleanup(() => { workspaceDb.close() })
  expect(workspaceDb.prepare('SELECT * FROM issues ORDER BY sequence').all())
    .toEqual(before.map((row) => ({ ...row, started_at: null, expected_files: null })))
  expect(migrated.issueTracker('project').list().every((entry) => entry.startedAt === undefined)).toBe(true)
  expect(workspaceDb.prepare('SELECT * FROM issue_dependencies').all())
    .toEqual([{ issue_id: 'queued', dependency_id: 'complete', position: 0 }])
  expect(workspaceDb.pragma('foreign_key_check')).toEqual([])
})

test('issues accept review status and reject unknown statuses', () => {
  const { db } = fixture()
  parent(db, 'p', 'task-a')
  const insert = (id: string, status: string): void => {
    db.prepare(`INSERT INTO issues (id, parent_id, title, description, checklist, validation, labels,
      priority, status, evidence, completed_at, reviewed_at) VALUES (?, ?, 'Issue', 'Description',
      '["Check"]', 'Run tests', '[]', 'high', ?, NULL, NULL, NULL)`).run(id, 'p', status)
  }
  insert('r', 'review')
  expect(db.prepare('SELECT status, reviewed_at FROM issues WHERE id = ?').get('r'))
    .toEqual({ status: 'review', reviewed_at: null })
  expect(() => insert('bad', 'pending')).toThrow(/CHECK/)
})

test('task and project deletion remove owned Valence records and incoming dependency links', () => {
  const { db } = fixture()
  parent(db, 'p-a', 'task-a')
  parent(db, 'p-b', 'task-b')
  issue(db, 'a', 'p-a')
  issue(db, 'b', 'p-b')
  db.prepare('INSERT INTO issue_dependencies VALUES (?, ?, ?)').run('b', 'a', 0)
  db.prepare('DELETE FROM tasks WHERE id = ?').run('task-a')
  expect(db.prepare('SELECT id FROM parent_issues').all()).toEqual([{ id: 'p-b' }])
  expect(db.prepare('SELECT id FROM issues').all()).toEqual([{ id: 'b' }])
  expect(db.prepare('SELECT * FROM issue_dependencies').all()).toEqual([])
  issue(db, 'c', 'p-b')
  expect(db.prepare('SELECT sequence FROM issues WHERE id = ?').get('c')).toEqual({ sequence: 3 })
  db.prepare('DELETE FROM projects WHERE id = ?').run('project')
  for (const table of ['tasks', 'parent_issues', 'issues', 'issue_dependencies']) {
    expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([])
  }
  expect(db.pragma('foreign_key_check')).toEqual([])
})
