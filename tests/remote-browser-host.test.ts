import { expect, test, vi } from 'vitest'
import { BrowserHostClient } from '../apps/server/src/browser-host-client'
import { RemoteBrowserHostTransport } from '../apps/server/src/remote-browser-host'

test('relays browser host requests and makes the client MCP endpoint reachable by the server', async () => {
  let transport: RemoteBrowserHostTransport
  const dispatch = vi.fn((request) => {
    transport.receive({
      type: 'anvil-browser-host-response', requestId: request.requestId, ok: true,
      connection: { url: 'http://127.0.0.1:6123/mcp', headers: { Authorization: 'Bearer browser' } }
    }, '::ffff:100.64.0.8')
  })
  transport = new RemoteBrowserHostTransport(dispatch)
  transport.register('100.64.0.8', [])
  const client = new BrowserHostClient(transport)

  const connection = await client.open('task-a', 'Task A')
  expect(connection).toMatchObject({ url: 'http://100.64.0.8:6123/mcp', headers: { Authorization: 'Bearer browser' } })
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ operation: 'open', taskId: 'task-a', title: 'Task A' }))

  await connection.close()
  expect(dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ operation: 'release', taskId: 'task-a' }))
  client.close()
  transport.close()
})

test('rejects browser requests until an Electron client registers', async () => {
  const transport = new RemoteBrowserHostTransport(() => {})
  const client = new BrowserHostClient(transport)
  await expect(client.open('task-a', 'Task A')).rejects.toThrow('desktop browser host is unavailable')
  client.close()
  transport.close()
})
