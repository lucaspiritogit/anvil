import { EventEmitter } from 'node:events'
import type { WebContents, WebPreferences } from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { expect, onTestFinished, test, vi } from 'vitest'
import { BrowserSessionManager } from '../apps/desktop/src/main/browser-sessions'
import { BrowserToolServer } from '../apps/desktop/src/main/browser-tools'

class FakeSession extends EventEmitter {
  setPermissionCheckHandler = vi.fn()
  setPermissionRequestHandler = vi.fn()
}

class FakeWebContents extends EventEmitter {
  session = new FakeSession()
  sendInputEvent = vi.fn()
  setZoomFactor = vi.fn()
  setWindowOpenHandler = vi.fn()
  reload = vi.fn()
  stop = vi.fn()
  entries: string[] = []
  index = -1
  navigationHistory = {
    canGoBack: () => this.index > 0,
    canGoForward: () => this.index < this.entries.length - 1,
    goBack: () => { this.index--; this.currentUrl = this.entries[this.index]; this.emit('did-navigate') },
    goForward: () => { this.index++; this.currentUrl = this.entries[this.index]; this.emit('did-navigate') }
  }
  capturePage = vi.fn(async () => ({ toPNG: () => Buffer.from('png') }))
  currentUrl = ''
  destroyed = false

  isDestroyed(): boolean {
    return this.destroyed
  }

  async loadURL(url: string): Promise<void> {
    this.entries = [...this.entries.slice(0, this.index + 1), url]
    this.index = this.entries.length - 1
    this.currentUrl = url
    this.emit('did-navigate')
  }

  getTitle(): string {
    return 'Fixture'
  }

  isLoading(): boolean {
    return false
  }

  close(): void {
    this.destroyed = true
    this.emit('destroyed')
  }

  getURL(): string {
    return this.currentUrl
  }

  async executeJavaScript(source: string): Promise<unknown> {
    if (source.includes("const selectorFor =")) {
      return { url: this.currentUrl, title: 'Fixture', viewport: { width: 1280, height: 800 }, text: 'Ready', elements: [] }
    }
    return null
  }
}

class FakeView {
  webContents = new FakeWebContents()
  setBounds = vi.fn()
  setVisible = vi.fn()
}

function browserFixture() {
  const views: FakeView[] = []
  const options: WebPreferences[] = []
  const removed: FakeView[] = []
  const changes: Array<{ taskId: string; open: boolean }> = []
  const manager = new BrowserSessionManager({
    create(value) {
      options.push(value)
      const view = new FakeView()
      views.push(view)
      return { ...view, webContents: view.webContents as unknown as WebContents }
    },
    remove(view) {
      removed.push(view as unknown as FakeView)
    }
  }, (state) => changes.push(state))
  return { manager, options, views, removed, changes }
}

test('places isolated task browsers inside the renderer-provided output pane', async () => {
  const fixture = browserFixture()
  await fixture.manager.open('task-a', 'First', 'http://127.0.0.1:4173/')
  await fixture.manager.open('task-a', 'First', 'http://localhost:4173/settings')
  await fixture.manager.open('task-b', 'Second', 'http://[::1]:4173/')

  expect(fixture.views).toHaveLength(2)
  expect(fixture.options[0]).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false, focusOnNavigation: false, webSecurity: true })
  expect(fixture.options[0]).not.toHaveProperty('backgroundThrottling')
  expect(fixture.options[0].partition).not.toBe(fixture.options[1].partition)
  expect(fixture.views[0].setBounds).toHaveBeenCalledWith({ x: 0, y: 0, width: 0, height: 0 })
  expect(fixture.views[0].setVisible).toHaveBeenCalledWith(false)
  expect(fixture.changes).toContainEqual(expect.objectContaining({ taskId: 'task-a', open: true, viewport: 'desktop', url: 'http://localhost:4173/settings' }))

  const bounds = { x: 500, y: 120, width: 640, height: 844 }
  fixture.manager.layout({ taskId: 'task-a', visible: true, bounds })
  expect(fixture.views[0].webContents.setZoomFactor).toHaveBeenLastCalledWith(0.5)
  expect(fixture.views[0].setBounds).toHaveBeenLastCalledWith({ x: 500, y: 342, width: 640, height: 400 })
  expect(fixture.views[0].setVisible).toHaveBeenLastCalledWith(true)
  expect(fixture.manager.viewport('task-a', 'mobile')).toMatchObject({ taskId: 'task-a', open: true, viewport: 'mobile' })
  expect(fixture.views[0].webContents.setZoomFactor).toHaveBeenLastCalledWith(1)
  expect(fixture.views[0].setBounds).toHaveBeenLastCalledWith({ x: 625, y: 120, width: 390, height: 844 })
  fixture.manager.layout({ taskId: 'task-b', visible: true, bounds })
  expect(fixture.views[0].setVisible).toHaveBeenLastCalledWith(false)
  fixture.manager.layout({ taskId: 'task-b', visible: false, bounds })
  expect(fixture.views[1].setVisible).toHaveBeenLastCalledWith(false)

  fixture.manager.closeAll()
  expect(fixture.removed).toHaveLength(2)
  expect(fixture.views.every((view) => view.webContents.destroyed)).toBe(true)
  expect(fixture.changes).toContainEqual({ taskId: 'task-a', open: false, viewport: 'mobile' })
})

test('places adaptive and zoomed layouts in the renderer-provided output pane', async () => {
  const fixture = browserFixture()
  await fixture.manager.open('task-a', 'First', 'http://127.0.0.1:4173/')
  const bounds = { x: 500, y: 120, width: 640, height: 700 }

  fixture.manager.layout({ taskId: 'task-a', visible: true, bounds, fit: false })
  expect(fixture.views[0].webContents.setZoomFactor).toHaveBeenLastCalledWith(1)
  expect(fixture.views[0].setBounds).toHaveBeenLastCalledWith(bounds)

  fixture.manager.layout({ taskId: 'task-a', visible: true, bounds, fit: false, zoom: 1.5 })
  expect(fixture.views[0].webContents.setZoomFactor).toHaveBeenLastCalledWith(1.5)
  expect(fixture.views[0].setBounds).toHaveBeenLastCalledWith(bounds)

  fixture.manager.layout({ taskId: 'task-a', visible: true, bounds, fit: false, zoom: 99 })
  expect(fixture.views[0].webContents.setZoomFactor).toHaveBeenLastCalledWith(2)

  fixture.manager.layout({ taskId: 'task-a', visible: true, bounds, fit: true, zoom: 2 })
  expect(fixture.views[0].webContents.setZoomFactor).toHaveBeenLastCalledWith(1)
  expect(fixture.views[0].setBounds).toHaveBeenLastCalledWith({ x: 500, y: 270, width: 640, height: 400 })

  fixture.manager.viewport('task-a', 'mobile')
  fixture.manager.layout({ taskId: 'task-a', visible: true, bounds, fit: false, zoom: 1.5 })
  expect(fixture.views[0].webContents.setZoomFactor).toHaveBeenLastCalledWith(expect.closeTo((700 / 844) * 1.5, 5))
  expect(fixture.views[0].setBounds).toHaveBeenLastCalledWith({ x: 658, y: 120, width: 323, height: 700 })

  fixture.manager.closeAll()
})

test('exposes browser actions through a turn-scoped MCP connection', async () => {
  const fixture = browserFixture()
  const server = new BrowserToolServer(fixture.manager)
  const client = new Client({ name: 'browser-test', version: '1' })
  onTestFinished(async () => {
    await client.close().catch(() => {})
    await server.close()
  })
  const connection = await server.open('task-a', 'Browser task')
  await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: connection.headers } }))
  expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['browser_open', 'browser_viewport']))

  server.setRemoteHost('100.64.0.10')
  const opened = await client.callTool({ name: 'browser_open', arguments: { url: 'http://localhost:4173/' } })
  expect(opened.isError).not.toBe(true)
  expect(fixture.views).toHaveLength(1)
  expect(fixture.views[0].webContents.currentUrl).toBe('http://100.64.0.10:4173/')
  const viewport = await client.callTool({ name: 'browser_viewport', arguments: { viewport: 'mobile' } })
  expect(viewport.isError).not.toBe(true)
  expect(fixture.manager.state('task-a').viewport).toBe('mobile')

  server.release('task-a')
  await expect(client.callTool({ name: 'browser_snapshot', arguments: {} })).rejects.toThrow('Streamable HTTP error')
  expect(fixture.views[0].webContents.destroyed).toBe(false)
  expect(fixture.manager.state('task-a')).toMatchObject({ open: true, url: 'http://100.64.0.10:4173/' })

  const next = await server.open('task-a', 'Browser task')
  const nextClient = new Client({ name: 'browser-test', version: '1' })
  onTestFinished(async () => { await nextClient.close().catch(() => {}) })
  await nextClient.connect(new StreamableHTTPClientTransport(new URL(next.url), { requestInit: { headers: next.headers } }))
  const snapshot = await nextClient.callTool({ name: 'browser_snapshot', arguments: {} })
  expect(snapshot.isError).not.toBe(true)
  expect(fixture.views).toHaveLength(1)
})

test('lets the user open and navigate the same task browser the agent uses', async () => {
  const fixture = browserFixture()
  await expect(fixture.manager.navigate('task-a', 'open', 'file:///etc/passwd')).rejects.toThrow('only opens HTTP or HTTPS')
  expect(fixture.views).toHaveLength(0)

  expect(await fixture.manager.navigate('task-a', 'open', 'http://localhost:5173/')).toMatchObject({
    open: true, url: 'http://localhost:5173/', title: 'Fixture', canGoBack: false, canGoForward: false
  })
  await fixture.manager.open('task-a', 'Agent', 'http://localhost:5173/settings')
  expect(fixture.views).toHaveLength(1)
  expect(fixture.manager.state('task-a')).toMatchObject({ url: 'http://localhost:5173/settings', canGoBack: true })

  expect(await fixture.manager.navigate('task-a', 'back')).toMatchObject({ url: 'http://localhost:5173/', canGoBack: false, canGoForward: true })
  expect(fixture.changes.at(-1)).toMatchObject({ taskId: 'task-a', url: 'http://localhost:5173/' })
  expect(await fixture.manager.navigate('task-a', 'forward')).toMatchObject({ url: 'http://localhost:5173/settings' })
  await fixture.manager.navigate('task-a', 'reload')
  expect(fixture.views[0].webContents.reload).toHaveBeenCalledOnce()

  fixture.manager.setRemoteHost('100.64.0.10')
  expect(await fixture.manager.navigate('task-a', 'open', 'http://localhost:5173/')).toMatchObject({ url: 'http://100.64.0.10:5173/' })

  expect(await fixture.manager.navigate('task-a', 'close')).toMatchObject({ open: false })
  expect(fixture.views[0].webContents.destroyed).toBe(true)
})

test('keeps a bounded number of task browsers alive', async () => {
  const fixture = browserFixture()
  for (let index = 0; index < 9; index++) await fixture.manager.open(`task-${index}`, 'Task', 'http://localhost:4173/')
  expect(fixture.views[0].webContents.destroyed).toBe(true)
  expect(fixture.views.slice(1).every((view) => !view.webContents.destroyed)).toBe(true)
  fixture.manager.closeAll()
})

test('lets the user browse any web URL while the agent stays on local pages', async () => {
  const fixture = browserFixture()
  expect(await fixture.manager.navigate('draft', 'open', 'https://example.com/docs')).toMatchObject({ open: true, url: 'https://example.com/docs' })
  await expect(fixture.manager.open('draft', 'Agent', 'https://example.com/')).rejects.toThrow('only opens localhost')
  const contents = fixture.views[0].webContents
  const navigation = { preventDefault: vi.fn() }
  contents.emit('will-navigate', navigation, 'https://example.org/')
  expect(navigation.preventDefault).not.toHaveBeenCalled()
  contents.emit('will-navigate', navigation, 'file:///etc/passwd')
  expect(navigation.preventDefault).toHaveBeenCalledOnce()
  const openHandler = contents.setWindowOpenHandler.mock.calls[0][0] as (details: { url: string }) => { action: string }
  expect(openHandler({ url: 'https://example.org/popup' })).toEqual({ action: 'deny' })
  await Promise.resolve()
  expect(contents.getURL()).toBe('https://example.org/popup')
})
