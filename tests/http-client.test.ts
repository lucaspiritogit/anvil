import { expect, test, vi } from 'vitest'
import { createHttpClient } from '@anvil/client-api'

class FakeEventSource {
  static OPEN = 1
  static current: FakeEventSource
  readyState = 1
  onopen?: () => void
  onerror?: () => void
  onmessage?: (event: { data: string }) => void
  close = vi.fn()
  constructor(readonly url: string) { FakeEventSource.current = this }
}

test('client gates readiness on health and SSE, reconnects and unsubscribes', async () => {
  vi.stubGlobal('EventSource', FakeEventSource)
  const health = vi.fn(async () => Response.json({ ok: true }))
  vi.stubGlobal('fetch', health)
  const ready = vi.fn()
  const failed = vi.fn()
  const client = createHttpClient('http://127.0.0.1:4780', ready, failed)
  const events = FakeEventSource.current
  expect(events.url).toBe('http://127.0.0.1:4780/events')
  expect(ready).not.toHaveBeenCalled()
  events.onerror!()
  expect(failed).not.toHaveBeenCalled()
  events.onopen!()
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce())
  const listener = vi.fn()
  const off = client.subscribe('task:updated', listener)
  events.onmessage!({ data: JSON.stringify({ channel: 'task:updated', payload: { id: 'task' } }) })
  expect(listener).toHaveBeenCalledWith({ id: 'task' })
  off()
  events.onmessage!({ data: JSON.stringify({ channel: 'task:updated', payload: { id: 'other' } }) })
  expect(listener).toHaveBeenCalledOnce()
  events.onerror!()
  expect(failed).toHaveBeenCalledWith(expect.stringContaining('Reconnecting'))
  events.onopen!()
  await vi.waitFor(() => expect(ready).toHaveBeenCalledTimes(2))
  client.close()
  expect(events.close).toHaveBeenCalledOnce()
})

test('client posts terminal input and preserves server error messages', async () => {
  vi.stubGlobal('EventSource', FakeEventSource)
  const request = vi.fn(async () => Response.json(null))
  vi.stubGlobal('fetch', request)
  const client = createHttpClient('http://127.0.0.1:4780', vi.fn(), vi.fn())
  await client.invoke('terminals:write', { sessionId: 'terminal', data: 'pwd\r' })
  expect(request).toHaveBeenCalledWith('http://127.0.0.1:4780/rpc', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ channel: 'terminals:write', input: { sessionId: 'terminal', data: 'pwd\r' } })
  }))
  request.mockResolvedValueOnce(Response.json({ error: 'Project not found' }, { status: 500 }))
  await expect(client.invoke('projects:reveal', 'missing')).rejects.toThrow('Project not found')
  client.close()
})

test('terminal writes stay ordered while other requests can proceed', async () => {
  vi.stubGlobal('EventSource', FakeEventSource)
  let finishFirst!: (response: Response) => void
  const firstResponse = new Promise<Response>((resolve) => { finishFirst = resolve })
  const request = vi.fn(async () => Response.json(null)).mockImplementationOnce(() => firstResponse)
  vi.stubGlobal('fetch', request)
  const client = createHttpClient('http://127.0.0.1:4780', vi.fn(), vi.fn())
  const first = client.invoke('terminals:write', { sessionId: 'terminal', data: 'first' })
  const second = client.invoke('terminals:write', { sessionId: 'terminal', data: 'second' })
  await Promise.resolve()
  expect(request).toHaveBeenCalledTimes(1)
  await client.invoke('workspaces:snapshot')
  expect(request).toHaveBeenCalledTimes(2)
  finishFirst(Response.json(null))
  await Promise.all([first, second])
  expect(request).toHaveBeenCalledTimes(3)
  expect(request.mock.calls[2]).toEqual(['http://127.0.0.1:4780/rpc', expect.objectContaining({
    body: JSON.stringify({ channel: 'terminals:write', input: { sessionId: 'terminal', data: 'second' } })
  })])
  client.close()
})

test('project import uploads a client folder to the connected server with a fixed workspace', async () => {
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('window', { addEventListener: vi.fn() })
  const { createAnvilApi } = await import('@anvil/client-api')
  const contents = new TextEncoder().encode('local checkout')
  const release = vi.fn(async () => {})
  const host: import('@anvil/client-api').ClientHost = {
    platform: 'linux', onSettingsOpen: () => () => {}, pickWallpaper: async () => null,
    pickProjectFolder: async () => ({ name: 'checkout', entries: [{ path: '.git/HEAD', type: 'file', size: contents.length,
      read: async (offset, length) => contents.slice(offset, offset + length) }], dispose: release }),
    openPath: async () => '', openPullRequest: async () => {}, openLoginUrl: async () => {},
    browserState: async (taskId) => ({ taskId, open: false, viewport: 'desktop' }),
    browserLayout: async () => {}, browserViewport: async ({ taskId, viewport }) => ({ taskId, open: false, viewport }),
    onBrowserChanged: () => () => {}
  }
  const requests: Array<{ url: string; input: RequestInit }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, input: RequestInit) => {
    requests.push({ url, input })
    if (url.endsWith('/project-import/import-id/0')) return Response.json({ ok: true })
    const { channel } = JSON.parse(input.body as string) as { channel: string }
    if (channel === 'projects:import-begin') return Response.json({ importId: 'import-id' })
    if (channel === 'projects:import-finish') return Response.json({ id: 'imported', name: 'checkout' })
    return Response.json(null)
  }))
  const api = createAnvilApi('https://remote.example', host)
  const progress = vi.fn()
  expect(await api.projects.importFromDisk('workspace-one', progress)).toMatchObject({ id: 'imported' })
  expect(JSON.parse(requests[0].input.body as string)).toEqual({ channel: 'projects:import-begin', input: {
    workspaceId: 'workspace-one', name: 'checkout', entries: [{ path: '.git/HEAD', type: 'file', size: contents.length }] } })
  expect(requests[1].url).toBe('https://remote.example/project-import/import-id/0')
  expect(new Uint8Array(requests[1].input.body as ArrayBuffer)).toEqual(contents)
  expect(progress).toHaveBeenLastCalledWith(contents.length, contents.length)
  expect(release).toHaveBeenCalledOnce()
})

test('project import cancellation does not start a transfer and a failed chunk cancels it', async () => {
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('window', { addEventListener: vi.fn() })
  const { createAnvilApi } = await import('@anvil/client-api')
  let selection: import('@anvil/client-api').ProjectFolderSelection | null = null
  const release = vi.fn(async () => {})
  const host: import('@anvil/client-api').ClientHost = {
    platform: 'linux', onSettingsOpen: () => () => {}, pickWallpaper: async () => null,
    pickProjectFolder: async () => selection, openPath: async () => '', openPullRequest: async () => {}, openLoginUrl: async () => {},
    browserState: async (taskId) => ({ taskId, open: false, viewport: 'desktop' }),
    browserLayout: async () => {}, browserViewport: async ({ taskId, viewport }) => ({ taskId, open: false, viewport }),
    onBrowserChanged: () => () => {}
  }
  const channels: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, input: RequestInit) => {
    if (url.includes('/project-import/')) return Response.json({ error: 'Transfer interrupted' }, { status: 500 })
    const { channel } = JSON.parse(input.body as string) as { channel: string }
    channels.push(channel)
    return Response.json(channel === 'projects:import-begin' ? { importId: 'import-id' } : null)
  }))
  const api = createAnvilApi('https://remote.example', host)
  expect(await api.projects.importFromDisk('workspace-one', vi.fn())).toBeNull()
  expect(channels).toEqual([])
  selection = { name: 'checkout', entries: [{ path: 'README.md', type: 'file', size: 1, read: async () => new Uint8Array([1]) }], dispose: release }
  await expect(api.projects.importFromDisk('workspace-one', vi.fn())).rejects.toThrow('Transfer interrupted')
  expect(channels).toEqual(['projects:import-begin', 'projects:import-cancel'])
  expect(release).toHaveBeenCalledOnce()
})
