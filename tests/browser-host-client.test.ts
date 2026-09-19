import { EventEmitter } from 'node:events'
import { expect, test, vi } from 'vitest'
import type { BrowserHostRequest } from '@anvil/protocol/browser-host'
import { BrowserHostClient } from '../apps/server/src/browser-host-client'

class HostTransport extends EventEmitter {
  connected = true
  sent: BrowserHostRequest[] = []

  send(message: BrowserHostRequest, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message)
    callback?.(null)
    queueMicrotask(() => {
      if (message.operation === 'open') {
        this.emit('message', { type: 'anvil-browser-host-response', requestId: message.requestId, ok: true,
          connection: { url: 'http://127.0.0.1:1234/mcp', headers: { Authorization: 'Bearer test' } } })
      } else {
        this.emit('message', { type: 'anvil-browser-host-response', requestId: message.requestId, ok: true })
      }
    })
    return true
  }
}

test('opens and releases the desktop browser capability over process IPC', async () => {
  const transport = new HostTransport()
  const client = new BrowserHostClient(transport)
  const connection = await client.open('task-a', 'Visible test')
  expect(connection).toMatchObject({ url: 'http://127.0.0.1:1234/mcp', headers: { Authorization: 'Bearer test' } })
  expect(transport.sent[0]).toMatchObject({ operation: 'open', taskId: 'task-a', title: 'Visible test' })

  await Promise.all([connection.close(), connection.close()])
  await vi.waitFor(() => expect(transport.sent.filter((request) => request.operation === 'release')).toHaveLength(1))
  client.close()
  expect(transport.listenerCount('message')).toBe(0)
})
