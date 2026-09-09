import { onTestCleanup } from './test-cleanup'
import { test, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { Store } from '../src/main/store'
import { WallpaperLibrary } from '../src/main/wallpapers'
import { registerSettingsHandlers } from '../src/main/ipc/settings'
import { rendererEvent, rendererIpc } from './renderer-fixture'
import { handlers } from './issue-tracker-doubles'

let root: string
let database: string
let store: Store
let wallpapers: WallpaperLibrary
const options = { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') }
const call = (channel: string, value?: unknown): any => handlers.get(channel)!(rendererEvent, value)

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'anvil-overview-settings-'))
  onTestCleanup(() => rmSync(root, { recursive: true, force: true }))
  database = join(root, 'settings.db')
  store = new Store(database, options)
  onTestCleanup(() => store.close())
  wallpapers = new WallpaperLibrary(root)
  registerSettingsHandlers(rendererIpc, store, wallpapers)
})

test('loads settings defaults', () => {
  expect(store.getSettings().fontSize).toBe(14)
  expect(store.getSettings().memoryEnabled).toBe(false)
  expect(store.getSettings().memoryEmbeddingModel).toBe('mxbai-embed-large')
  expect(store.getSettings().ollamaBaseUrl).toBe('http://localhost:11434/v1')
  expect(store.getSettings().overviewBackgroundMode).toBe('color')
  expect(store.getSettings().overviewBackgroundColor).toBe('#0d0f12')
  expect(store.getSettings().overviewWallpaperId).toBe(null)
})

test('rejects unauthorized wallpaper senders and invalid settings payloads', () => {
  for (const channel of ['wallpapers:directory', 'wallpapers:list', 'wallpapers:read']) {
    expect(() => handlers.get(channel)!({ sender: {}, senderFrame: null })).toThrow(/Unauthorized IPC sender/)
  }
  for (const id of ['../escape.png', '/escape.png', 'a\\b.png', 'x.png\0', 'file:///a.png', 'x'.repeat(256) + '.png', 'x.svg', null]) {
    expect(() => call('wallpapers:read', id)).toThrow(/Invalid IPC request/)
  }
  expect(call('wallpapers:directory')).toBe(wallpapers.directory)
  expect(() => call('wallpapers:directory', '/tmp')).toThrow(/Invalid IPC request/)
  expect(() => call('wallpapers:list', '/tmp')).toThrow(/Invalid IPC request/)
  for (const patch of [{ overviewBackgroundMode: 'video' }, { overviewBackgroundColor: 'red' }, { overviewBackgroundColor: '#123456\n' }, { overviewWallpaperId: '../x.png' }, { overviewWallpaperId: 'data:image/png;base64,abc' }]) {
    expect(() => call('settings:set', patch)).toThrow(/Invalid IPC request/)
  }
  for (const fontSize of [11, 19, 14.5, '16', null]) {
    expect(() => call('settings:set', { fontSize })).toThrow(/Invalid IPC request/)
  }
  for (const patch of [{ memoryEnabled: 'true' }, { memoryEmbeddingModel: '' }, { memoryEmbeddingModel: 'bad model' }, { ollamaBaseUrl: 'file:///tmp' }, { ollamaBaseUrl: 'http://user:password@localhost/v1' }]) {
    expect(() => call('settings:set', patch)).toThrow(/Invalid IPC request/)
  }
})

test('persists settings and wallpaper selection across restarts', async () => {
  call('settings:set', { fontSize: 16, memoryEnabled: true, memoryEmbeddingModel: 'custom-model', ollamaBaseUrl: 'http://127.0.0.1:11434/v1' })
  writeFileSync(join(root, 'wallpaper', 'test.png'), await sharp({ create: { width: 1, height: 1, channels: 3, background: 'red' } }).png().toBuffer())
  expect(await call('wallpapers:list')).toStrictEqual([{ id: 'test.png', name: 'test.png', width: 1, height: 1 }])
  expect(await call('wallpapers:read', 'test.png')).toMatch(/^data:image\/webp;base64,/)
  expect(await call('wallpapers:read', 'removed.png')).toBe(null)
  call('settings:set', { overviewBackgroundMode: 'image', overviewBackgroundColor: '#123456', overviewWallpaperId: 'test.png', caffeineMode: true })
  call('settings:set', { overviewBackgroundMode: 'color' })
  expect(store.getSettings().overviewWallpaperId, 'Mode changes retain selection').toBe('test.png')
  call('settings:set', { overviewBackgroundMode: 'image' })
  store.close()
  store = new Store(database, options)
  expect(store.getSettings().fontSize, 'Font size survives restart').toBe(16)
  expect(store.getSettings().memoryEnabled).toBe(true)
  expect(store.getSettings().memoryEmbeddingModel).toBe('custom-model')
  expect(store.getSettings().ollamaBaseUrl).toBe('http://127.0.0.1:11434/v1')
  expect(store.getSettings().overviewBackgroundMode).toBe('image')
  expect(store.getSettings().overviewBackgroundColor).toBe('#123456')
  expect(store.getSettings().overviewWallpaperId).toBe('test.png')
  expect(store.getSettings().caffeineMode, 'Existing settings survive').toBe(true)
  store.setSettings({ overviewWallpaperId: null })
  store.close()
  store = new Store(database, options)
  expect(store.getSettings().overviewWallpaperId, 'Cleared selection survives reopen').toBe(null)
  store.close()
})

test('recovers corrupt and legacy settings while preserving other preferences', async () => {
  store.setSettings({ caffeineMode: true })
  store.close()
  const raw = new Database(database)
  for (const [key, value] of Object.entries({ fontSize: 'garbage', overviewBackgroundMode: 'garbage', overviewBackgroundColor: 'url(file:///secret)', overviewWallpaperId: '../secret.png' })) {
    raw.prepare('UPDATE workspace_settings SET value = ? WHERE key = ?').run(value, key)
  }
  raw.close()
  store = new Store(database, options)
  expect(store.getSettings().overviewBackgroundMode).toBe('color')
  expect(store.getSettings().overviewBackgroundColor).toBe('#0d0f12')
  expect(store.getSettings().overviewWallpaperId).toBe(null)
  expect(store.getSettings().caffeineMode).toBe(true)
  expect(store.getSettings().fontSize, 'Invalid font size falls back').toBe(14)
  store.close()
  const legacy = new Database(database)
  legacy.prepare("DELETE FROM workspace_settings WHERE key LIKE 'overview%'").run()
  legacy.close()
  store = new Store(database, options)
  expect(store.getSettings().overviewBackgroundColor, 'Older databases receive defaults').toBe('#0d0f12')
  expect(store.getSettings().caffeineMode).toBe(true)
})
