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
  capturePage = vi.fn(async () => ({ toPNG: () => Buffer.from('png') }))
  currentUrl = ''
  destroyed = false

  isDestroyed(): boolean {
    return this.destroyed
  }

  async loadURL(url: string): Promise<void> {
    this.currentUrl = url
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
  expect(fixture.changes).toContainEqual({ taskId: 'task-a', open: true, viewport: 'desktop' })

  const bounds = { x: 500, y: 120, width: 640, height: 844 }
  fixture.manager.layout({ taskId: 'task-a', visible: true, bounds })
  expect(fixture.views[0].webContents.setZoomFactor).toHaveBeenLastCalledWith(0.5)
  expect(fixture.views[0].setBounds).toHaveBeenLastCalledWith({ x: 500, y: 342, width: 640, height: 400 })
  expect(fixture.views[0].setVisible).toHaveBeenLastCalledWith(true)
  expect(fixture.manager.viewport('task-a', 'mobile')).toEqual({ taskId: 'task-a', open: true, viewport: 'mobile' })
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
  expect(fixture.views[0].webContents.destroyed).toBe(true)
})
