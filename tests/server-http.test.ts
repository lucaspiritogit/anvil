import { expect, test } from 'vitest'
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { request } from 'node:http'
import { networkInterfaces } from 'node:os'
import { EventEmitter } from 'node:events'
import { createAnvilHttpServer, isLoopbackAddress, RPC_BODY_LIMIT } from '../src/server/http'
import { createHandlerRegistry } from '../src/server/handler-registry'
import { createCredentialEncryption } from '../src/server/credential-encryption'
import { encodeRpcInput } from '../src/shared/rpc-codec'
import { TASK_IMAGE_LIMITS } from '../src/shared/types'
import { registerTestIpc } from './test-ipc'
import { onTestCleanup } from './test-cleanup'
import { pngWithDimensions } from './image-fixtures'
import { testHome } from './issue-tracker-doubles'

async function serve(runtime = registerTestIpc()) {
  const http = createAnvilHttpServer(runtime, { version: 'test', rendererOrigin: 'http://localhost:5173' })
  const url = await http.listen(0)
  onTestCleanup(() => http.close())
  const rpc = (channel: string, input?: unknown) => fetch(`${url}/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel, input })
  })
  return { url, rpc }
}

test('HTTP exposes health, snapshots and validated domain handlers on loopback', async () => {
  const { url, rpc } = await serve()
  expect(await (await fetch(`${url}/health`)).json()).toEqual({ ok: true, version: 'test' })
  expect(await (await rpc('workspaces:snapshot')).json()).toMatchObject({ workspaces: expect.any(Array) })
  const invalid = await rpc('workspaces:rename', { workspaceId: '../outside', name: 'invalid' })
  expect(invalid.status).toBe(400)
  expect(await invalid.json()).toMatchObject({ error: expect.stringContaining('Invalid IPC request') })
  expect((await rpc('__proto__')).status).toBe(400)
  const path = mkdtempSync(join(testHome, 'http-project-'))
  const project = await (await rpc('projects:add', { path })).json() as { id: string; path: string }
  expect(project.path).toBe(path)
  expect(await (await rpc('projects:reveal', project.id)).json()).toBe(path)
  expect(await (await rpc('github:open-pr-url', 'https://github.com/o/r/pull/1')).json()).toBe('https://github.com/o/r/pull/1')
  expect((await rpc('projects:add')).status).toBe(400)
  const wallpaperPath = join(path, 'wallpaper.png')
  writeFileSync(wallpaperPath, pngWithDimensions(2, 3))
  const wallpaper = await (await rpc('wallpapers:import', { path: wallpaperPath, workspaceId: 'default' })).json() as { id: string }
  expect(wallpaper).toMatchObject({ width: 2, height: 3 })
  expect(await (await rpc('wallpapers:read', wallpaper.id)).json()).toEqual(expect.stringMatching(/^data:image\/png;base64,/))
})

test('HTTP rejects foreign origins, DNS rebinding, malformed JSON and oversized bodies', async () => {
  const { url } = await serve()
  expect((await fetch(`${url}/health`, { headers: { Origin: 'https://evil.example' } })).status).toBe(403)
  const rebindingStatus = await new Promise<number | undefined>((resolve, reject) => {
    const probe = request(`${url}/health`, { headers: { Host: 'evil.example' } }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    probe.on('error', reject)
    probe.end()
  })
  expect(rebindingStatus).toBe(403)
  for (const origin of ['null', 'http://localhost:5173']) {
    const response = await fetch(`${url}/rpc`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe(origin)
  }
  expect((await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status).toBe(400)
  expect((await fetch(`${url}/rpc`, { method: 'POST', body: '{}' })).status).toBe(415)
  expect((await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: ' '.repeat(RPC_BODY_LIMIT + 1) })).status).toBe(413)
  expect(isLoopbackAddress('127.0.0.1')).toBe(true)
  expect(isLoopbackAddress('::1')).toBe(true)
  for (const address of ['0.0.0.0', '192.168.1.2', undefined]) expect(isLoopbackAddress(address)).toBe(false)
})

const lanAddress = Object.values(networkInterfaces()).flat().find((address) => address?.family === 'IPv4' && !address.internal)?.address

test.skipIf(!lanAddress)('LAN mode authenticates every non-loopback route and keeps loopback compatible', async () => {
  const http = createAnvilHttpServer(registerTestIpc(), {
    version: 'test',
    rendererOrigin: 'http://localhost:5173',
    auth: { verifyPassword: async (candidate) => candidate === 'secret' }
  })
  const loopbackUrl = await http.listen(0)
  onTestCleanup(() => http.close())
  await http.rebind(true)
  const port = new URL(loopbackUrl).port
  const remoteUrl = `http://${lanAddress}:${port}`
  const credentials = `Basic ${Buffer.from('anvil:secret').toString('base64')}`

  for (const [path, init] of [
    ['/health', undefined],
    ['/events', undefined],
    ['/rpc', { method: 'OPTIONS' }],
    ['/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }],
    ['/missing', undefined]
  ] as const) {
    const response = await fetch(`${remoteUrl}${path}`, init)
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('Basic realm="Anvil"')
  }
  expect((await fetch(`${remoteUrl}/health`, { headers: { Authorization: 'Basic broken' } })).status).toBe(401)
  expect((await fetch(`${remoteUrl}/health`, { headers: { Authorization: `Basic ${Buffer.from('other:secret').toString('base64')}` } })).status).toBe(401)
  expect((await fetch(`${remoteUrl}/health`, { headers: { Authorization: credentials } })).status).toBe(200)
  expect((await fetch(`${loopbackUrl}/health`)).status).toBe(200)

  const rejectedHost = await new Promise<number | undefined>((resolve, reject) => {
    const probe = request(`${remoteUrl}/health`, { headers: { Authorization: credentials, Host: 'evil.example' } }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode))
    })
    probe.on('error', reject)
    probe.end()
  })
  expect(rejectedHost).toBe(403)
  const missing = await fetch(`${remoteUrl}/missing`, { headers: { Authorization: credentials } })
  expect(missing.status).toBe(404)
  const preflight = await fetch(`${remoteUrl}/rpc`, { method: 'OPTIONS', headers: { Authorization: credentials } })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get('access-control-allow-headers')).toContain('Authorization')

  const events = await fetch(`${remoteUrl}/events`, { headers: { Authorization: credentials } })
  expect(events.status).toBe(200)
  await events.body?.cancel()
  await http.rebind(false)
  await expect(fetch(`${remoteUrl}/health`)).rejects.toThrow()
  expect((await fetch(`${loopbackUrl}/health`)).status).toBe(200)
})

test('SSE receives runtime broadcasts and disconnects cleanly', async () => {
  const runtime = registerTestIpc()
  const { url, rpc } = await serve(runtime)
  const controller = new AbortController()
  onTestCleanup(() => controller.abort())
  const response = await fetch(`${url}/events`, { signal: controller.signal })
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  expect(decoder.decode((await reader.read()).value)).toContain(': connected')
  await rpc('workspaces:create', 'HTTP workspace')
  const event = decoder.decode((await reader.read()).value)
  expect(event).toContain('"channel":"workspaces:changed"')
  expect(event).toContain('HTTP workspace')
  await reader.cancel()
})

test('HTTP keeps exact routes, JSON errors and empty RPC results', async () => {
  const http = createAnvilHttpServer({
    invoke: (channel) => {
      if (channel === 'projects:list') throw new Error('Database unavailable')
      if (channel === 'agents:list') throw 'Non-Error rejection'
      return undefined
    },
    subscribeAll: () => () => {}
  }, { version: 'test' })
  const url = await http.listen(0)
  onTestCleanup(() => http.close())
  for (const path of ['/missing', '/health/', '/health?query=1']) {
    const response = await fetch(`${url}${path}`)
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: 'Not found' })
    expect(response.headers.get('cache-control')).toBe('no-store')
  }
  expect((await fetch(`${url}/health`, { method: 'HEAD' })).status).toBe(404)
  const rpc = (body: unknown) => fetch(`${url}/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  })
  expect(await (await rpc({ channel: 'workspaces:snapshot' })).json()).toBeNull()
  const failed = await rpc({ channel: 'projects:list' })
  expect(failed.status).toBe(500)
  expect(await failed.json()).toEqual({ error: 'Database unavailable' })
  const rejected = await rpc({ channel: 'agents:list' })
  expect(rejected.status).toBe(500)
  expect(await rejected.json()).toEqual({ error: 'RPC failed' })
  for (const body of [null, [], {}, { channel: 1 }, { channel: 'projects:list', extra: true }]) {
    expect((await rpc(body)).status).toBe(400)
  }
})

test('HTTP enforces the body limit for chunked requests without Content-Length', async () => {
  const { url } = await serve()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const chunk = new Uint8Array(1024 * 1024).fill(32)
      for (let size = 0; size <= RPC_BODY_LIMIT; size += chunk.byteLength) controller.enqueue(chunk)
      controller.close()
    }
  })
  const response = await fetch(`${url}/rpc`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body, duplex: 'half'
  } as RequestInit)
  expect(response.status).toBe(413)
  expect(await response.json()).toEqual({ error: 'RPC body too large' })
})

test('HTTP shutdown closes active event streams and unsubscribes from runtime events', async () => {
  let unsubscribed = false
  const http = createAnvilHttpServer({
    invoke: () => undefined,
    subscribeAll: () => () => { unsubscribed = true }
  }, { version: 'test' })
  const url = await http.listen(0)
  onTestCleanup(() => http.close())
  const response = await fetch(`${url}/events`)
  const reader = response.body!.getReader()
  await reader.read()
  const closing = http.close()
  expect((await reader.read()).done).toBe(true)
  await closing
  expect(unsubscribed).toBe(true)
})

test('HTTP decodes base64 before validation, including the complete 20 MiB image budget', async () => {
  const registry = createHandlerRegistry()
  let received: Uint8Array[] = []
  registry.handle('tasks:start', (input) => { received = input.images!.map((image) => image.bytes); return { count: received.length } })
  const events = new EventEmitter()
  const http = createAnvilHttpServer({ invoke: registry.invoke, subscribeAll: (listener) => {
    events.on('event', listener)
    return () => { events.off('event', listener) }
  } }, { version: 'test' })
  const url = await http.listen(0)
  onTestCleanup(() => http.close())
  const bytes = new Uint8Array(TASK_IMAGE_LIMITS.perImageBytes).fill(253)
  const input = { projectId: 'project', agentId: 'codex', prompt: 'Images', images: [
    { filename: 'one.png', mimeType: 'image/png', bytes }, { filename: 'two.png', mimeType: 'image/png', bytes }
  ] }
  const body = JSON.stringify({ channel: 'tasks:start', input: encodeRpcInput('tasks:start', input) })
  expect(body.length).toBeLessThan(RPC_BODY_LIMIT)
  const response = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
  expect(await response.json()).toEqual({ count: 2 })
  expect(received.every((image) => image instanceof Uint8Array && Buffer.from(image).equals(Buffer.from(bytes)))).toBe(true)
  input.images[0].bytes = new Uint8Array([1])
  const encoded = encodeRpcInput('tasks:start', input) as { images: { bytes: string }[] }
  encoded.images[0].bytes = '!invalid!'
  const invalid = await fetch(`${url}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel: 'tasks:start', input: encoded }) })
  expect(invalid.status).toBe(400)
})

test('server credential encryption persists a private key and authenticates ciphertext', () => {
  const path = join(mkdtempSync(join(testHome, 'encryption-')), 'credentials.key')
  const encryption = createCredentialEncryption(path)
  const ciphertext = encryption.encryptString('fixture-token')
  expect(ciphertext.includes(Buffer.from('fixture-token'))).toBe(false)
  expect(statSync(path).mode & 0o777).toBe(0o600)
  expect(readFileSync(path)).toHaveLength(32)
  expect(createCredentialEncryption(path).decryptString(ciphertext)).toBe('fixture-token')
  ciphertext[ciphertext.length - 1] ^= 1
  expect(() => encryption.decryptString(ciphertext)).toThrow()
})
