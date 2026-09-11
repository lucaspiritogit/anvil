import { expect, test } from 'vitest'
import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/server/store'
import { migrateBefore, migrationsFolder } from './migration-fixture'
import { onTestCleanup } from './test-cleanup'

test('workspace switching separates projects and creates a database in each workspace directory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'anvil-workspace-storage-'))
  onTestCleanup(() => rmSync(directory, { recursive: true, force: true }))
  const store = new Store(join(directory, 'anvil.db'), { migrationsFolder })
  onTestCleanup(() => store.close())
  store.addProject({ id: 'personal', name: 'Personal', path: '/test/personal', createdAt: 1,
    monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
  const work = store.createWorkspace('Work')
  store.selectWorkspace(work.id)
  expect(store.getProjects()).toEqual([])
  for (const workspace of store.getWorkspaces()) {
    expect(existsSync(join(store.getWorkspaceDirectory(workspace.id), 'anvil.db'))).toBe(true)
  }
  for (const suffix of ['', '-wal', '-shm']) expect(existsSync(join(directory, 'anvil.db' + suffix))).toBe(false)
  expect(JSON.parse(readFileSync(join(directory, 'config.json'), 'utf8')).activeWorkspaceId).toBe(work.id)
  store.selectWorkspace('default')
  expect(store.getProjects().map((project) => project.id)).toEqual(['personal'])
})

test('named workspace folders preserve config, issues and Git worktrees through rename and restart', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-workspace-rename-')))
  onTestCleanup(() => rmSync(directory, { recursive: true, force: true }))
  const registryPath = join(directory, 'anvil.db')
  let store = new Store(registryPath, { migrationsFolder })
  onTestCleanup(() => store.close())
  const workspace = store.createWorkspace('My Work')
  const oldDirectory = store.getWorkspaceDirectory(workspace.id)
  expect(oldDirectory).toBe(join(directory, 'workspaces', 'My Work'))
  mkdirSync(join(oldDirectory, 'config'))
  writeFileSync(join(oldDirectory, 'config', 'marker'), 'private config')
  const repository = join(directory, 'repo')
  mkdirSync(repository)
  const git = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
  git(repository, ['init', '-b', 'main'])
  git(repository, ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'Initial'])
  const worktree = join(oldDirectory, 'worktrees', 'task')
  git(repository, ['worktree', 'add', '-b', 'task', worktree])
  store.addProject({ id: 'project', name: 'Project', path: repository, createdAt: 1,
    monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' }, workspace.id)
  store.addTask({ id: 'task', workspaceId: workspace.id, projectId: 'project', agentId: 'codex', agentLabel: 'Codex',
    title: 'Task', prompt: 'Task', cwd: worktree, status: 'succeeded', startedAt: 1, deliveryStatus: 'reviewable',
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null, filesChanged: 0, additions: 0, deletions: 0 })
  store.issueTracker('project', workspace.id).createParent({ anvilTaskId: 'task', title: 'Saved plan' })
  store.renameWorkspace(workspace.id, 'Client Work')
  const newDirectory = store.getWorkspaceDirectory(workspace.id)
  expect(newDirectory).toBe(join(directory, 'workspaces', 'Client Work'))
  expect(existsSync(oldDirectory)).toBe(false)
  expect(readFileSync(join(newDirectory, 'config', 'marker'), 'utf8')).toBe('private config')
  expect(store.getTask('task')?.cwd).toBe(join(newDirectory, 'worktrees', 'task'))
  expect(git(repository, ['worktree', 'list', '--porcelain'])).toContain(`worktree ${join(newDirectory, 'worktrees', 'task')}`)
  store.close()
  store = new Store(registryPath, { migrationsFolder })
  expect(store.issueTracker('project', workspace.id).listParents()[0].title).toBe('Saved plan')
  expect(store.getWorkspaceDirectory(workspace.id)).toBe(newDirectory)
  for (const name of ['../escape', '.', '..', 'bad/name', 'bad\\name', 'bad:', 'trailing.']) {
    expect(() => store.createWorkspace(name)).toThrow(/folder name/)
  }
})

test('splits existing profiles without copying unrelated projects or credentials and preserves legacy assets on restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'anvil-workspace-migration-'))
  onTestCleanup(() => rmSync(directory, { recursive: true, force: true }))
  const database = join(directory, 'anvil.db')
  migrateBefore(database, 12)
  const registry = new Database(database)
  onTestCleanup(() => { if (registry.open) registry.close() })
  const work = '00000000-0000-0000-0000-000000000001'
  registry.prepare('INSERT INTO workspaces VALUES (?, ?, ?, 1)').run('default', 'Default', 'default')
  registry.prepare('INSERT INTO workspaces VALUES (?, ?, ?, 2)').run(work, 'Work', 'work')
  registry.prepare("INSERT INTO projects (id, name, path, created_at) VALUES ('personal', 'Personal', '/personal', 1), ('work', 'Work', '/work', 2)").run()
  registry.prepare(`INSERT INTO tasks (id, project_id, agent_id, agent_label, prompt, title, cwd, status, started_at, workspace_id)
    VALUES ('work-task', 'work', 'codex', 'Codex', 'Task', 'Task', '/work', 'succeeded', 1, ?)`).run(work)
  mkdirSync(join(directory, 'wallpaper'))
  mkdirSync(join(directory, 'memory'))
  writeFileSync(join(directory, 'wallpaper', 'photo.png'), 'wallpaper marker')
  writeFileSync(join(directory, 'memory', 'marker'), 'memory marker')
  writeFileSync(join(directory, 'github-token.enc'), 'credential marker')

  registry.close()
  for (let pass = 0; pass < 2; pass++) {
    const store = new Store(database, { migrationsFolder })
    try {
      expect(store.getProjects(work).map((project) => project.id)).toEqual(['work'])
      expect(store.getProjects('default').map((project) => project.id)).toEqual(['personal', 'work'])
      expect(store.getTasks(work).map((task) => task.id)).toEqual(['work-task'])
      expect(store.getTasks('default')).toEqual([])
      const defaultDirectory = store.getWorkspaceDirectory('default')
      expect(readFileSync(join(defaultDirectory, 'wallpaper', 'photo.png'), 'utf8')).toBe('wallpaper marker')
      expect(readFileSync(join(defaultDirectory, 'memory', 'marker'), 'utf8')).toBe('memory marker')
      expect(readFileSync(join(defaultDirectory, 'github-token.enc'), 'utf8')).toBe('credential marker')
      expect(existsSync(join(store.getWorkspaceDirectory(work), 'github-token.enc'))).toBe(false)
      expect(existsSync(database)).toBe(false)
      expect(existsSync(join(directory, 'backups', 'anvil.before-root-json.db'))).toBe(true)
    } finally {
      store.close()
    }
  }
})

test('migrates an already split registry to JSON without replacing workspace databases', () => {
  const directory = mkdtempSync(join(tmpdir(), 'anvil-root-json-upgrade-'))
  onTestCleanup(() => rmSync(directory, { recursive: true, force: true }))
  const configFile = join(directory, 'config.json')
  let store = new Store(configFile, { migrationsFolder })
  onTestCleanup(() => store.close())
  const workspace = store.createWorkspace('Work')
  store.selectWorkspace(workspace.id)
  store.setSettings({ fontSize: 18 })
  const workspaces = store.getWorkspaces()
  store.close()
  const databaseFile = join(directory, 'anvil.db')
  migrateBefore(databaseFile, 1000)
  const registry = new Database(databaseFile)
  registry.pragma('journal_mode = WAL')
  for (const entry of workspaces) {
    registry.prepare('INSERT INTO workspaces VALUES (?, ?, ?, ?)').run(entry.id, entry.name, entry.name.toLowerCase(), entry.createdAt)
  }
  registry.prepare("INSERT INTO app_state VALUES ('workspaceStorageVersion', '1'), ('workspaceDirectoryVersion', '1'), ('activeWorkspaceId', ?)")
    .run(workspace.id)
  registry.close()
  rmSync(configFile)
  for (let pass = 0; pass < 2; pass++) {
    store = new Store(configFile, { migrationsFolder })
    expect(store.getWorkspaces()).toEqual(workspaces)
    expect(store.getActiveWorkspace()).toEqual(workspace)
    expect(store.getSettings().fontSize).toBe(18)
    expect(JSON.parse(readFileSync(configFile, 'utf8'))).toEqual({ version: 1, workspaces, activeWorkspaceId: workspace.id })
    for (const suffix of ['', '-wal', '-shm']) expect(existsSync(databaseFile + suffix)).toBe(false)
    store.close()
  }
})

test('rejects corrupt JSON without replacing config or creating a root database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'anvil-root-json-invalid-'))
  onTestCleanup(() => rmSync(directory, { recursive: true, force: true }))
  const filename = join(directory, 'config.json')
  for (const source of ['{broken', JSON.stringify({ version: 2, workspaces: [] }), JSON.stringify({
    version: 1, workspaces: [{ id: 'default', name: '../escape', createdAt: 1 }], activeWorkspaceId: 'default'
  })]) {
    writeFileSync(filename, source)
    expect(() => new Store(filename, { migrationsFolder })).toThrow()
    expect(readFileSync(filename, 'utf8')).toBe(source)
    expect(existsSync(join(directory, 'anvil.db'))).toBe(false)
  }
})

test('failed JSON writes preserve workspace selection and roll back created or renamed folders', () => {
  const directory = mkdtempSync(join(tmpdir(), 'anvil-root-json-write-'))
  onTestCleanup(() => rmSync(directory, { recursive: true, force: true }))
  const filename = join(directory, 'config.json')
  let store = new Store(filename, { migrationsFolder })
  onTestCleanup(() => store.close())
  const work = store.createWorkspace('Work')
  const original = store.getWorkspaces()
  const savedConfig = join(directory, 'saved-config.json')
  renameSync(filename, savedConfig)
  mkdirSync(filename)
  expect(() => store.selectWorkspace(work.id)).toThrow()
  expect(() => store.createWorkspace('Failed')).toThrow()
  expect(() => store.renameWorkspace(work.id, 'Renamed')).toThrow()
  expect(store.getWorkspaces()).toEqual(original)
  expect(store.getActiveWorkspace().id).toBe('default')
  expect(existsSync(join(directory, 'workspaces', 'Work', 'anvil.db'))).toBe(true)
  expect(existsSync(join(directory, 'workspaces', 'Failed'))).toBe(false)
  expect(existsSync(join(directory, 'workspaces', 'Renamed'))).toBe(false)
  rmSync(filename, { recursive: true })
  renameSync(savedConfig, filename)
  store.close()
  store = new Store(filename, { migrationsFolder })
  expect(store.getWorkspaces()).toEqual(original)
  expect(store.getActiveWorkspace().id).toBe('default')
})
