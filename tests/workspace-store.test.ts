import { expect, test } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/server/store'
import { DEFAULT_WORKSPACE_ID, MAX_WORKSPACE_NAME_LENGTH } from '../src/shared/types'
import type { Settings, Task } from '../src/shared/types'
import { migrateBefore, migrationsFolder } from './migration-fixture'
import { onTestCleanup } from './test-cleanup'

function fixture(): { directory: string; database: string; open: () => Store } {
  const directory = mkdtempSync(join(tmpdir(), 'anvil-workspaces-'))
  onTestCleanup(() => rmSync(directory, { recursive: true, force: true }))
  const database = join(directory, 'config.json')
  return {
    directory,
    database,
    open: () => {
      const store = new Store(database, { migrationsFolder })
      onTestCleanup(() => store.close())
      return store
    }
  }
}

function rawDatabase(path: string): Database.Database {
  const db = new Database(path)
  db.pragma('foreign_keys = ON')
  onTestCleanup(() => { if (db.open) db.close() })
  return db
}

function addProject(store: Store, id = 'project', workspaceId = store.getActiveWorkspace().id): void {
  store.addProject({
    id, name: id, path: `/test/${id}`, createdAt: 1, monthlyTokenLimit: null,
    monthlyCostLimitUsd: null, finishOnPush: true, gitPlatform: 'github'
  }, workspaceId)
}

function taskInput(id: string): Omit<Task, 'workspaceId'> {
  return {
    id, projectId: 'project', agentId: 'codex', agentLabel: 'Codex', prompt: 'Task', title: 'Task',
    cwd: '/test/project', status: 'succeeded', startedAt: 1, exitCode: null, deliveryStatus: 'reviewable',
    inputTokens: 1, outputTokens: 2, cachedTokens: 0, totalTokens: 3, costUsd: null,
    filesChanged: 0, additions: 0, deletions: 0, sessionId: 'existing-session'
  }
}

test('creates one Default workspace and starts new profiles with independent application defaults', () => {
  const { open, directory } = fixture()
  const store = open()
  const initial = store.getActiveWorkspace()
  expect(initial).toMatchObject({ id: DEFAULT_WORKSPACE_ID, name: 'Default' })
  expect(initial.createdAt).toBeGreaterThan(0)
  expect(store.getWorkspaces()).toEqual([initial])
  const defaults = store.getSettings()
  addProject(store)
  const custom: Settings = {
    autoCompactContext: false, contextCompactionThreshold: 85,
    memoryEnabled: true, memoryEmbeddingModel: 'custom-model', ollamaBaseUrl: 'http://127.0.0.1:1234/v1',
    fontSize: 18, overviewBackgroundMode: 'image', overviewBackgroundColor: '#123456', overviewWallpaperId: 'test.png',
    defaultAgentId: 'codex', defaultModel: 'custom-model', rebaseMode: 'agent', confirmRebase: false,
    caffeineMode: true, allowOtherDevices: true, tailscaleHttps: true,
    keybindings: { toggleSidebar: 'Mod+Y', focusTaskComposer: 'Mod+K' }
  }
  expect(Object.keys(custom).sort()).toEqual(Object.keys(defaults).sort())
  store.setSettings(custom)
  store.setWorkspacePreferences({
    composer: { agentId: 'codex', modelsByAgent: { codex: 'custom-model' }, reasoningByAgentModel: { '["codex","custom-model"]': 'high' } },
    lastProjectId: 'project'
  })
  const work = store.createWorkspace('Work')
  expect(work.id).not.toBe(initial.id)
  expect(store.getActiveWorkspace()).toEqual(initial)
  store.selectWorkspace(work.id)
  expect(store.getSettings()).toEqual(defaults)
  expect(store.getWorkspacePreferences()).toEqual({
    composer: { agentId: '', modelsByAgent: {}, reasoningByAgentModel: {} }, lastProjectId: null
  })
  expect(store.getProjects()).toEqual([])
  expect(store.getProjects(initial.id)[0].finishOnPush).toBe(true)
  expect(store.getWorkspaceDirectory(work.id)).toBe(join(directory, 'workspaces', work.name))
  expect(existsSync(store.getWorkspaceDatabasePath(work.id))).toBe(true)
  expect(existsSync(join(store.getWorkspaceDirectory(work.id), 'codex', 'auth.json'))).toBe(false)
  expect(store.getSettings(initial.id)).toEqual(custom)
  expect(store.getWorkspacePreferences(initial.id).lastProjectId).toBe('project')
  const db = rawDatabase(store.getWorkspaceDatabasePath(work.id))
  expect(db.prepare('SELECT count(*) AS count FROM workspace_settings WHERE workspace_id = ?').get(work.id))
    .toEqual({ count: Object.keys(defaults).length })
  expect(db.pragma('foreign_key_check')).toEqual([])
  store.close()
  const reopened = open()
  expect(reopened.getSettings(initial.id)).toEqual(custom)
  expect(reopened.getSettings(work.id)).toEqual(defaults)
})

test('persists every settings field, composer selections and selected project independently across restarts', () => {
  const { open } = fixture()
  let store = open()
  addProject(store)
  const initial = store.getActiveWorkspace()
  const work = store.createWorkspace('Work')
  addProject(store, 'project', work.id)
  const workTask = store.addTask({ ...taskInput('work-task'), workspaceId: work.id })
  store.setSettings({ defaultAgentId: 'codex', caffeineMode: true }, work.id)
  store.setWorkspacePreferences({
    composer: { agentId: 'codex', modelsByAgent: { codex: 'work-model' }, reasoningByAgentModel: { '["codex","work-model"]': 'high' } },
    lastProjectId: 'project'
  }, work.id)
  store.selectWorkspace(work.id)
  const expectedSettings = store.getSettings()
  const expectedPreferences = store.getWorkspacePreferences()
  store.close()
  store = open()
  expect(store.getWorkspaces()).toEqual([initial, work].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)))
  expect(store.getActiveWorkspace()).toEqual(work)
  expect(store.getSettings()).toEqual(expectedSettings)
  expect(store.getWorkspacePreferences()).toEqual(expectedPreferences)
  expect(store.getTask(workTask.id)?.workspaceId).toBe(work.id)
  expect(store.getTasks(initial.id)).toEqual([])
  expect(store.getSettings(initial.id).caffeineMode).toBe(false)
  expect(store.getWorkspacePreferences(initial.id).lastProjectId).toBe(null)
  store.selectWorkspace(initial.id)
  store.close()
  store = open()
  expect(store.getActiveWorkspace()).toEqual(initial)
})

test('does not share mutable defaults, returned preferences or caller-owned objects', () => {
  const { open } = fixture()
  const store = open()
  const work = store.createWorkspace('Work')
  const settings = store.getSettings()
  settings.keybindings.toggleSidebar = 'Mutated'
  const preferences = store.getWorkspacePreferences()
  preferences.composer.modelsByAgent.codex = 'Mutated'
  expect(store.getSettings().keybindings.toggleSidebar).toBe('Mod+B')
  expect(store.getSettings(work.id).keybindings.toggleSidebar).toBe('Mod+B')
  expect(store.getWorkspacePreferences().composer.modelsByAgent).toEqual({})
  store.setWorkspacePreferences(preferences, work.id)
  preferences.composer.modelsByAgent.codex = 'Changed again'
  expect(store.getWorkspacePreferences(work.id).composer.modelsByAgent.codex).toBe('Mutated')
  const db = rawDatabase(store.getWorkspaceDatabasePath('default'))
  db.prepare("UPDATE workspace_settings SET value = 'broken json' WHERE key = 'keybindings'").run()
  store.getSettings().keybindings.toggleSidebar = 'Changed fallback'
  expect(store.getSettings(work.id).keybindings.toggleSidebar).toBe('Mod+B')
  db.prepare("DELETE FROM workspace_settings WHERE key = 'keybindings'").run()
  store.getSettings().keybindings.toggleSidebar = 'Changed missing default'
  expect(store.getSettings(work.id).keybindings.toggleSidebar).toBe('Mod+B')
})

test('validates bounded normalized names, duplicates and unknown workspace IDs', () => {
  const { open } = fixture()
  const store = open()
  for (const name of ['', '   ', 'x'.repeat(MAX_WORKSPACE_NAME_LENGTH + 1), 'A\nB', 'A\u0000B', 'A\u200bB']) {
    expect(() => store.createWorkspace(name)).toThrow(/Workspace name/)
  }
  const work = store.createWorkspace('  Work   account  ')
  expect(work.name).toBe('Work account')
  for (const name of ['work account', 'WORK ACCOUNT', 'Ｗork account']) {
    expect(() => store.createWorkspace(name)).toThrow(/already exists/)
  }
  expect(() => store.renameWorkspace(work.id, ' DEFAULT ')).toThrow(/already exists/)
  expect(() => store.renameWorkspace(work.id, ' ')).toThrow(/Workspace name/)
  expect(store.renameWorkspace(work.id, 'WORK ACCOUNT').id).toBe(work.id)
  expect(store.createWorkspace('x'.repeat(MAX_WORKSPACE_NAME_LENGTH)).name).toHaveLength(MAX_WORKSPACE_NAME_LENGTH)
  expect(() => store.selectWorkspace('missing')).toThrow(/not found/)
  expect(() => store.renameWorkspace('missing', 'Name')).toThrow(/not found/)
  expect(() => store.getSettings('missing')).toThrow(/not found/)
  expect(() => store.setSettings({ caffeineMode: true }, 'missing')).toThrow(/not found/)
  expect(() => store.getWorkspacePreferences('missing')).toThrow(/not found/)
  expect(() => store.getWorkspaceDirectory('../outside')).toThrow(/not found/)
  expect(store.getActiveWorkspace().id).toBe(DEFAULT_WORKSPACE_ID)
})

test('renaming moves credentials to the named folder and keeps workspace identity stable', () => {
  const { open } = fixture()
  let store = open()
  const initial = store.getActiveWorkspace()
  const directory = store.getWorkspaceDirectory(initial.id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'auth.json'), 'test credential marker')
  store.renameWorkspace(initial.id, 'Personal')
  const replacement = store.createWorkspace('Default')
  store.selectWorkspace(replacement.id)
  expect(store.getWorkspaceDirectory(initial.id)).toBe(join(directory, '..', 'Personal'))
  store.close()
  store = open()
  expect(store.getWorkspaces()).toHaveLength(2)
  expect(store.getActiveWorkspace()).toEqual(replacement)
  expect(store.getWorkspaces().find((entry) => entry.id === initial.id)?.name).toBe('Personal')
  expect(readFileSync(join(store.getWorkspaceDirectory(initial.id), 'auth.json'), 'utf8')).toBe('test credential marker')
  expect(existsSync(store.getWorkspaceDatabasePath(replacement.id))).toBe(true)
  expect(existsSync(join(store.getWorkspaceDirectory(replacement.id), 'auth.json'))).toBe(false)
})

test('recovers missing or invalid active selections deterministically and persists the recovery', () => {
  const { open, directory } = fixture()
  let store = open()
  const work = store.createWorkspace('Work')
  store.selectWorkspace(work.id)
  store.close()
  const configFile = join(directory, 'config.json')
  const config = JSON.parse(readFileSync(configFile, 'utf8'))
  config.activeWorkspaceId = 'missing'
  writeFileSync(configFile, JSON.stringify(config))
  store = open()
  expect(store.getActiveWorkspace().id).toBe(DEFAULT_WORKSPACE_ID)
  expect(JSON.parse(readFileSync(configFile, 'utf8')).activeWorkspaceId).toBe(DEFAULT_WORKSPACE_ID)
  store.selectWorkspace(work.id)
  store.close()
  delete config.activeWorkspaceId
  writeFileSync(configFile, JSON.stringify(config))
  store = open()
  expect(store.getActiveWorkspace().id).toBe(DEFAULT_WORKSPACE_ID)
})

test('enforces foreign keys, immutable task ownership and independent project selection', () => {
  const { open } = fixture()
  const store = open()
  addProject(store)
  const defaultTask = store.addTask(taskInput('default-task'))
  const work = store.createWorkspace('Work')
  store.selectWorkspace(work.id)
  addProject(store)
  const workTask = store.addTask(taskInput('work-task'))
  expect(defaultTask.workspaceId).toBe(DEFAULT_WORKSPACE_ID)
  expect(workTask.workspaceId).toBe(work.id)
  expect(store.getTasks(work.id)).toEqual([workTask])
  expect(store.getTasks(DEFAULT_WORKSPACE_ID)).toEqual([defaultTask])
  expect(store.getTasks()).toHaveLength(2)
  const patch = { workspaceId: work.id, title: 'Reassigned' }
  expect(() => store.updateTask(defaultTask.id, patch)).toThrow(/ownership cannot change/)
  expect(store.updateTask(defaultTask.id, { title: 'Updated' })?.workspaceId).toBe(DEFAULT_WORKSPACE_ID)
  expect(() => store.addTask({ ...taskInput('invalid'), workspaceId: 'missing' })).toThrow(/not found/)
  const db = rawDatabase(store.getWorkspaceDatabasePath(work.id))
  expect(() => db.prepare("UPDATE tasks SET workspace_id = 'missing' WHERE id = ?").run(workTask.id)).toThrow(/FOREIGN KEY/)
  expect(() => db.prepare('UPDATE tasks SET workspace_id = NULL WHERE id = ?').run(workTask.id)).toThrow(/NOT NULL/)
  expect(() => db.prepare('DELETE FROM workspaces WHERE id = ?').run(work.id)).toThrow(/FOREIGN KEY/)
  expect(() => db.prepare("INSERT INTO workspace_settings VALUES ('missing', 'key', 'value')").run()).toThrow(/FOREIGN KEY/)
  expect(() => db.prepare("INSERT INTO workspace_preferences VALUES ('missing', '{}', NULL)").run()).toThrow(/FOREIGN KEY/)
  expect(() => store.setWorkspacePreferences({ lastProjectId: 'missing' })).toThrow(/FOREIGN KEY/)
  store.setWorkspacePreferences({ lastProjectId: 'project' })
  store.setWorkspacePreferences({ lastProjectId: 'project' }, DEFAULT_WORKSPACE_ID)
  store.removeProject('project')
  expect(store.getWorkspacePreferences().lastProjectId).toBe(null)
  expect(store.getWorkspacePreferences(DEFAULT_WORKSPACE_ID).lastProjectId).toBe('project')
  expect(store.getWorkspaces()).toHaveLength(2)
  expect(store.getTasks().map((task) => task.id)).toEqual([defaultTask.id])
  expect(db.pragma('foreign_key_check')).toEqual([])
})

test('loads pull request metadata only for the current reviewable task revision', () => {
  const { open } = fixture()
  const store = open()
  addProject(store)
  const task = store.addTask({ ...taskInput('pull-request-task'), headCommit: 'current-head' })
  store.linkPullRequest(task.id, {
    repository: 'Developer/Project', number: 17, headSha: 'current-head',
    sourceBranch: 'task-branch', targetBranch: 'main'
  })

  const pullRequest = { number: 17, url: 'https://github.com/developer/project/pull/17' }
  expect(store.getTask(task.id)?.pullRequest).toEqual(pullRequest)
  expect(store.getTasks()[0].pullRequest).toEqual(pullRequest)

  store.close()
  const reopened = open()
  expect(reopened.getTask(task.id)?.pullRequest).toEqual(pullRequest)
  expect(reopened.getTasks()[0].pullRequest).toEqual(pullRequest)

  expect(reopened.updateTask(task.id, { headCommit: 'new-head' })?.pullRequest).toBeUndefined()
  expect(reopened.getTask(task.id)?.pullRequest).toBeUndefined()
  expect(reopened.getTasks()[0].pullRequest).toBeUndefined()

  expect(reopened.updateTask(task.id, { headCommit: 'current-head', deliveryStatus: 'approved' })?.pullRequest).toBeUndefined()
  expect(reopened.getTask(task.id)?.pullRequest).toBeUndefined()
})


test('opens and migrates only the active workspace until another workspace is selected', () => {
  const { open, directory } = fixture()
  const inactiveId = '00000000-0000-0000-0000-000000000002'
  const inactiveDirectory = join(directory, 'workspaces', 'Later')
  mkdirSync(inactiveDirectory, { recursive: true })
  const inactiveDatabase = join(inactiveDirectory, 'anvil.db')
  migrateBefore(inactiveDatabase, 12)
  const before = readFileSync(inactiveDatabase)
  writeFileSync(join(directory, 'config.json'), JSON.stringify({
    version: 1,
    workspaces: [
      { id: 'default', name: 'Default', createdAt: 1 },
      { id: inactiveId, name: 'Later', createdAt: 2 }
    ],
    activeWorkspaceId: 'default'
  }))
  const store = open()
  expect(store.getOpenedWorkspaces().map((workspace) => workspace.id)).toEqual(['default'])
  expect(store.getTasks()).toEqual([])
  expect(store.getTask('unknown')).toBeUndefined()
  expect(store.getPullRequestsToRefresh()).toEqual([])
  expect(readFileSync(inactiveDatabase)).toEqual(before)
  expect(existsSync(`${inactiveDatabase}-wal`)).toBe(false)

  store.selectWorkspace(inactiveId)
  expect(store.getOpenedWorkspaces()).toHaveLength(2)
  expect(store.getSettings()).toEqual(store.getSettings('default'))
  expect(store.getWorkspacePreferences().lastProjectId).toBeNull()
  const migrated = rawDatabase(inactiveDatabase)
  expect(migrated.prepare("SELECT name FROM sqlite_master WHERE name = 'task_executions'").get()).toBeDefined()
  migrated.close()
  addProject(store)
  store.addTask({ ...taskInput('running-later'), status: 'running' })
  store.selectWorkspace('default')
  store.selectWorkspace(inactiveId)
  expect(store.getTask('running-later')?.status).toBe('running')
  store.selectWorkspace('default')
  store.close()

  const reopened = open()
  expect(reopened.getOpenedWorkspaces().map((workspace) => workspace.id)).toEqual(['default'])
  reopened.selectWorkspace(inactiveId)
  expect(reopened.getTask('running-later')).toMatchObject({ status: 'pending', error: 'Interrupted by app restart' })
})

test('keeps the active workspace when opening another workspace fails', () => {
  const { open, directory } = fixture()
  const store = open()
  const other = store.createWorkspace('Broken')
  store.close()
  writeFileSync(join(directory, 'workspaces', 'Broken', 'anvil.db'), 'invalid database')
  const reopened = open()
  expect(() => reopened.selectWorkspace(other.id)).toThrow()
  expect(reopened.getActiveWorkspace().id).toBe('default')
  expect(JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8')).activeWorkspaceId).toBe('default')
})
