import { expect, test, vi } from 'vitest'
import { createHttpClient } from '../src/client/preload/http-client'

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
