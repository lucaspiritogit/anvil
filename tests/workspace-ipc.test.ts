import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { beforeEach, expect, test, vi } from 'vitest'
import { Store } from '../src/server/store'
import { WallpaperLibrary } from '../src/server/wallpapers'
import { registerSettingsHandlers } from '../src/server/handlers/settings'
import { registerWorkspaceHandlers } from '../src/server/handlers/workspaces'
import { handlers, testHome } from './issue-tracker-doubles'
import { rendererEvent, rendererIpc } from './renderer-fixture'
import { onTestCleanup } from './test-cleanup'
import type { ComposerPreferences, Settings, WorkspaceSnapshot } from '../src/shared/types'
import { useStore } from '../src/client/renderer/src/state/store'
import { useComposerPreferences } from '../src/client/renderer/src/state/composer-preferences'

const options = { migrationsFolder: join(process.cwd(), 'src/server/db/migrations') }
const composer: ComposerPreferences = {
  agentId: 'codex', modelsByAgent: { codex: 'work-model', opencode: 'provider/model' },
  reasoningByAgentModel: { '["codex","work-model"]': 'high', '["opencode","provider/model"]': 'low' }
}
let store: Store
let database: string
const broadcast = vi.fn()
function call(channel: string, value?: unknown): any {
  return handlers.get(channel)!(rendererEvent, value)
}
function snapshot(): WorkspaceSnapshot { return call('workspaces:snapshot') }

beforeEach(() => {
  database = join(testHome, `workspace-ipc-${randomUUID()}`, 'config.json')
  store = new Store(database, options)
  onTestCleanup(() => store.close())
  broadcast.mockClear()
  registerSettingsHandlers(rendererIpc, store, new WallpaperLibrary(testHome), (change) => broadcast('settings:changed', change))
  registerWorkspaceHandlers(rendererIpc, store, broadcast)
})

test('workspace IPC validates representation and existence before mutation', async () => {
  for (const id of ['', '../personal', '/tmp', 'DEFAULT', null, {}, 'a'.repeat(100), '00000000-0000-0000-0000-000000000000']) {
    await expect(async () => call('workspaces:select', id)).rejects.toThrow()
    expect(() => call('workspaces:preferences:get', id)).toThrow()
    expect(() => call('settings:set', { workspaceId: id, patch: { fontSize: 18 } })).toThrow()
    expect(() => call('workspaces:preferences:set', { workspaceId: id, patch: { composer } })).toThrow()
    await expect(async () => call('workspaces:rename', { workspaceId: id, name: 'Name' })).rejects.toThrow()
  }
  expect(() => call('settings:set', { fontSize: 18 })).toThrow()
  expect(() => call('settings:set', { workspaceId: 'default', patch: { fontSize: '18' } })).toThrow()
  expect(() => call('workspaces:preferences:set', { workspaceId: 'default', patch: { composer: { ...composer, modelsByAgent: { codex: 2 } } } })).toThrow()
  expect(() => call('workspaces:preferences:set', { workspaceId: 'default', patch: { lastProjectId: 'missing' } })).toThrow('Project not found')
  for (const name of ['', ' ', 'bad\nname', 'a'.repeat(81), null]) expect(() => call('workspaces:create', name)).toThrow()
  expect(snapshot().workspace.id).toBe('default')
  expect(snapshot().settings.fontSize).toBe(14)
})

test('independent settings and composer choices survive selection, rename and SQLite restart', async () => {
  const original = snapshot()
  const work = call('workspaces:create', ' Work ')
  const patch: Partial<Settings> = {
    fontSize: 18, defaultAgentId: 'codex', defaultModel: 'work-model', memoryEnabled: true,
    memoryEmbeddingModel: 'custom-model', ollamaBaseUrl: 'http://localhost:1234/v1',
    overviewBackgroundMode: 'image', overviewBackgroundColor: '#123456', overviewWallpaperId: 'work.png',
    rebaseMode: 'agent', confirmRebase: false, caffeineMode: true,
    keybindings: { toggleSidebar: 'Mod+Shift+B', focusTaskComposer: 'Mod+Shift+N' }
  }
  call('settings:set', { workspaceId: work.id, patch })
  call('workspaces:preferences:set', { workspaceId: work.id, patch: { composer } })
  expect(snapshot()).toEqual({ ...original, workspaces: call('workspaces:list') })
  expect(broadcast).toHaveBeenCalledWith('settings:changed', { workspaceId: work.id, settings: expect.objectContaining(patch) })
  const selected = await call('workspaces:select', work.id)
  expect(selected.settings).toMatchObject(patch)
  expect(selected.preferences.composer).toEqual(composer)
  expect(broadcast).toHaveBeenCalledWith('workspaces:selected', selected)
  await call('workspaces:rename', { workspaceId: work.id, name: 'Office' })
  store.close()
  store = new Store(database, options)
  expect(store.getActiveWorkspace()).toMatchObject({ id: work.id, name: 'Office' })
  expect(store.getSettings(work.id)).toEqual(selected.settings)
  expect(store.getWorkspacePreferences(work.id).composer).toEqual(composer)
  expect(store.getSettings('default')).toEqual(original.settings)
})

function rendererBridge(): void {
  vi.stubGlobal('window', { anvil: {
    workspaces: {
      snapshot: async () => snapshot(),
      select: async (id: string) => call('workspaces:select', id),
      setPreferences: async (workspaceId: string, patch: unknown) => call('workspaces:preferences:set', { workspaceId, patch })
    },
    agents: { list: async () => [] },
    settings: { set: async (workspaceId: string, patch: Partial<Settings>) => call('settings:set', { workspaceId, patch }) }
  } })
  useStore.setState({ ready: false, activeWorkspaceId: null, workspaceSwitching: false, workspaceError: null })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

test('pending settings and composer writes retain their owner across rapid switches', async () => {
  rendererBridge()
  await useStore.getState().load()
  const work = store.createWorkspace('Work')
  const personal = store.createWorkspace('Personal')
  const gate = deferred<void>()
  const bridgeSet = window.anvil.settings.set
  const writes: string[] = []
  window.anvil.settings.set = async (id, patch) => {
    writes.push(id)
    await gate.promise
    return bridgeSet(id, patch)
  }
  const save = useStore.getState().saveSettings({ fontSize: 18 })
  useComposerPreferences.getState().setSelection('codex', 'private-model')
  const first = useStore.getState().selectWorkspace(work.id)
  const second = useStore.getState().selectWorkspace(personal.id)
  expect(useStore.getState().activeWorkspaceId).toBe('default')
  expect(useStore.getState().workspaceSwitching).toBe(true)
  gate.resolve()
  await Promise.all([save, first, second])
  expect(writes).toEqual(['default'])
  expect(store.getSettings('default').fontSize).toBe(18)
  expect(store.getWorkspacePreferences('default').composer.modelsByAgent.codex).toBe('private-model')
  expect(useStore.getState()).toMatchObject({ activeWorkspaceId: personal.id, settings: { fontSize: 14 }, workspaceSwitching: false })
  expect(useComposerPreferences.getState()).toMatchObject({ workspaceId: personal.id, agentId: '' })
  useStore.getState().applySettingsChange({ workspaceId: 'default', settings: store.getSettings('default') })
  expect(useStore.getState().settings?.fontSize).toBe(14)
})

test('failed latest switch restores main and keeps the previous coherent profile recoverable', async () => {
  rendererBridge()
  await useStore.getState().load()
  const work = store.createWorkspace('Work')
  const original = useStore.getState().settings
  const first = useStore.getState().selectWorkspace(work.id)
  const failed = useStore.getState().selectWorkspace(randomUUID())
  await Promise.all([first, failed])
  expect(useStore.getState()).toMatchObject({ activeWorkspaceId: 'default', settings: original, workspaceSwitching: false, workspaceError: 'Workspace not found' })
  expect(store.getActiveWorkspace().id).toBe('default')
  await useStore.getState().selectWorkspace(work.id)
  expect(useStore.getState()).toMatchObject({ activeWorkspaceId: work.id, workspaceError: null })
})

test('hydration ignores stale responses and exposes preferences only with a complete snapshot', async () => {
  rendererBridge()
  const gate = deferred<WorkspaceSnapshot>()
  const original = snapshot()
  window.anvil.workspaces.snapshot = () => gate.promise
  const load = useStore.getState().load()
  await Promise.resolve()
  const work = store.createWorkspace('Work')
  store.setWorkspacePreferences({ composer }, work.id)
  const selection = useStore.getState().selectWorkspace(work.id)
  expect(useStore.getState().ready).toBe(false)
  gate.resolve(original)
  await Promise.all([load, selection])
  expect(useStore.getState().activeWorkspaceId).toBe(work.id)
  expect(useComposerPreferences.getState().modelsByAgent).toEqual(composer.modelsByAgent)
})

test('last selected projects are independent and restored with the workspace snapshot', async () => {
  for (const id of ['first', 'second']) store.addProject({
    id, name: id, path: join(testHome, id), createdAt: 0, monthlyTokenLimit: null, monthlyCostLimitUsd: null,
    finishOnPush: false, gitPlatform: 'github'
  })
  rendererBridge()
  await useStore.getState().load()
  useStore.getState().selectProject('second')
  const work = store.createWorkspace('Work')
  store.addProject(store.getProjects('default').find((project) => project.id === 'first')!, work.id)
  await useStore.getState().selectWorkspace(work.id)
  useStore.getState().selectProject('first')
  await useStore.getState().selectWorkspace('default')
  expect(useStore.getState().activeProjectId).toBe('second')
  await useStore.getState().load()
  expect(useStore.getState().activeProjectId).toBe('second')
  expect(store.getWorkspacePreferences(work.id).lastProjectId).toBe('first')
})
