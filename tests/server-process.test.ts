import { EventEmitter } from 'node:events'
import { expect, test, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { connectToServer } from '../src/client/main/server-process'
import { serverAddress } from '../src/shared/server-address'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

const options = {
  executable: '/electron', entry: '/app/out/server/index.js', dataDirectory: '/data',
  rendererUrl: 'file:///app/out/renderer/index.html', packaged: true, environment: {}
}

function childProcess() {
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null as number | null, signalCode: null,
    kill: vi.fn((_signal: string) => {
      child.exitCode = 0
      queueMicrotask(() => child.emit('exit', 0))
      return true
    }) })
  vi.mocked(spawn).mockImplementation(() => child as never)
  return child
}

test('attaches to an explicit server without spawning or stopping it', async () => {
  vi.mocked(spawn).mockClear()
  const health = vi.fn(async () => Response.json({ ok: true, service: 'anvil', version: 'test', ready: true }))
  vi.stubGlobal('fetch', health)
  const connection = await connectToServer({ ...options, environment: { ANVIL_SERVER_URL: 'http://127.0.0.1:4781' } })
  await connection.close()
  expect(connection.url).toBe('http://127.0.0.1:4781')
  expect(spawn).not.toHaveBeenCalled()
  expect(health).toHaveBeenCalledWith('http://127.0.0.1:4781/health', expect.anything())
})

test('spawns Electron as Node, waits for its own ready signal and closes only its child', async () => {
  const child = childProcess()
  const health = vi.fn(async () => Response.json({ ok: true, service: 'anvil', version: 'test', ready: true }))
    .mockRejectedValueOnce(Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' }))
  vi.stubGlobal('fetch', health)
  const pending = connectToServer({ ...options, environment: { ANVIL_SERVER_PORT: '4790' } })
  await vi.waitFor(() => expect(child.listenerCount('message')).toBe(1))
  expect(health).toHaveBeenCalledTimes(1)
  child.emit('message', { type: 'anvil-server-ready', url: 'http://127.0.0.1:4790' })
  const connection = await pending
  expect(health).toHaveBeenCalledTimes(2)
  expect(spawn).toHaveBeenCalledWith('/electron', ['/app/out/server/index.js'], expect.objectContaining({
    env: expect.objectContaining({ ELECTRON_RUN_AS_NODE: '1', ANVIL_SERVER_PORT: '4790', ANVIL_DATA_DIR: '/data', ANVIL_RENDERER_ORIGIN: 'null' })
  }))
  await Promise.all([connection.close(), connection.close()])
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
})

test('does not attach to an unrelated listener if its child exits during startup', async () => {
  const child = childProcess()
  const health = vi.fn()
    .mockRejectedValueOnce(Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' }))
    .mockResolvedValueOnce(Response.json({ ok: true, version: 'unrelated' }))
  vi.stubGlobal('fetch', health)
  const pending = connectToServer(options)
  const rejected = expect(pending).rejects.toThrow('not a compatible Anvil server')
  await vi.waitFor(() => expect(child.listenerCount('exit')).toBe(1))
  child.exitCode = 1
  child.emit('exit', 1)
  await rejected
  expect(health).toHaveBeenCalledTimes(2)
  expect(child.kill).not.toHaveBeenCalled()
})

test('attaches to an existing server on the configured port without owning it', async () => {
  vi.mocked(spawn).mockClear()
  const health = vi.fn(async () => Response.json({ ok: true, service: 'anvil', version: 'test', ready: true }))
  vi.stubGlobal('fetch', health)
  const connection = await connectToServer({ ...options, environment: { ANVIL_SERVER_PORT: '4790' } })
  expect(connection.url).toBe('http://127.0.0.1:4790')
  await connection.close()
  expect(spawn).not.toHaveBeenCalled()
})

test('reports the child startup failure when no other server claimed the port', async () => {
  const child = childProcess()
  const health = vi.fn().mockRejectedValue(new TypeError('fetch failed', {
    cause: Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' })
  }))
  vi.stubGlobal('fetch', health)
  const pending = connectToServer(options)
  const rejected = expect(pending).rejects.toThrow('exited during startup (1)')
  await vi.waitFor(() => expect(child.listenerCount('exit')).toBe(1))
  child.exitCode = 1
  child.emit('exit', 1)
  await rejected
  expect(health).toHaveBeenCalledTimes(2)
})

test('attaches without ownership when another Anvil server wins the startup race', async () => {
  const child = childProcess()
  const health = vi.fn(async () => Response.json({ ok: true, service: 'anvil', version: 'test', ready: true }))
    .mockRejectedValueOnce(Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' }))
  vi.stubGlobal('fetch', health)
  const pending = connectToServer(options)
  await vi.waitFor(() => expect(child.listenerCount('exit')).toBe(1))
  child.exitCode = 1
  child.emit('exit', 1)
  const connection = await pending
  expect(connection.url).toBe('http://127.0.0.1:4780')
  await connection.close()
  expect(child.kill).not.toHaveBeenCalled()
  expect(health).toHaveBeenCalledTimes(2)
})

test('server addresses cannot select a remote machine or inject URL components', () => {
  expect(serverAddress('http://127.0.0.1:4780/')).toBe('http://127.0.0.1:4780')
  for (const url of ['https://127.0.0.1:4780', 'http://localhost:4780', 'http://192.168.1.2:4780',
    'http://user@127.0.0.1:4780', 'http://127.0.0.1:4780/rpc', 'http://127.0.0.1:4780/?q=1']) {
    expect(() => serverAddress(url)).toThrow()
  }
})
