import { expect, test, vi } from 'vitest'
import { ServerConnectionManager, type ServerConnectionState } from '../src/client/main/server-connection-manager'
import type { ServerTarget } from '../src/shared/server-address'
import type { ServerConnection } from '../src/client/main/server-process'

class SettingsFixture {
  saved: ServerTarget | undefined
  readonly calls: string[] = []

  constructor(saved?: ServerTarget) {
    this.saved = saved
  }

  async load(): Promise<ServerTarget | undefined> {
    this.calls.push('load')
    return this.saved
  }

  async resolve(): Promise<ServerTarget> {
    this.calls.push('resolve')
    return this.saved ?? { mode: 'local' }
  }

  async save(target: ServerTarget): Promise<ServerTarget> {
    this.calls.push(`save:${target.mode}`)
    this.saved = target
    return target
  }

  async clear(): Promise<void> {
    this.calls.push('clear')
    this.saved = undefined
  }
}

function connection(url: string, calls: string[], name: string): ServerConnection {
  return { url, close: async () => { calls.push(`close:${name}`) } }
}

function fixture(saved?: ServerTarget) {
  const settings = new SettingsFixture(saved)
  const calls: string[] = []
  const connections = new Map<string, ServerConnection>([
    ['local', connection('http://127.0.0.1:4780', calls, 'local')],
    ['https://one.example', connection('https://one.example', calls, 'one')],
    ['https://two.example', connection('https://two.example', calls, 'two')]
  ])
  const connect = vi.fn(async (target: ServerTarget) => {
    const key = target.mode === 'local' ? 'local' : target.url
    calls.push(`connect:${key}`)
    const result = connections.get(key)
    if (!result) throw new Error(`No Anvil server is running at ${key}.`)
    return result
  })
  const reconnect = vi.fn(async (state: ServerConnectionState) => { calls.push(`reconnect:${state.url}`) })
  const startActivity = vi.fn((url: string) => {
    calls.push(`activity:${url}`)
    return () => { calls.push(`stop:${url}`) }
  })
  const manager = new ServerConnectionManager({ settings, connect, reconnect, startActivity })
  return { manager, settings, calls, connect, reconnect, startActivity }
}

test('restores the saved startup target and disposes its scoped activity on close', async () => {
  const target = { mode: 'remote', url: 'https://one.example' } as const
  const { manager, settings, calls } = fixture(target)
  await expect(manager.start()).resolves.toEqual({ target, url: target.url })
  expect(settings.calls).toEqual(['resolve'])
  expect(calls).toEqual(['connect:https://one.example', 'activity:https://one.example'])
  await manager.close()
  expect(calls.slice(-2)).toEqual(['stop:https://one.example', 'close:one'])
})

test('establishes and persists a candidate before reconnecting and cleaning up the previous connection', async () => {
  const { manager, settings, calls } = fixture({ mode: 'local' })
  await manager.start()
  settings.calls.length = 0
  calls.length = 0
  const target = { mode: 'remote', url: 'https://one.example/' } as const
  await expect(manager.setTarget(target)).resolves.toEqual({ target: { mode: 'remote', url: 'https://one.example' }, url: 'https://one.example' })
  expect(settings.calls).toEqual(['load', 'save:remote'])
  expect(calls).toEqual([
    'connect:https://one.example',
    'activity:https://one.example',
    'reconnect:https://one.example',
    'stop:http://127.0.0.1:4780',
    'close:local'
  ])
  expect(settings.saved).toEqual({ mode: 'remote', url: 'https://one.example' })
})

test('retains local ownership when remote mode attaches to the same effective server', async () => {
  const { manager, settings, calls, connect } = fixture({ mode: 'local' })
  await manager.start()
  connect.mockResolvedValueOnce(connection('http://127.0.0.1:4780', calls, 'attached'))
  calls.length = 0
  await manager.setTarget({ mode: 'remote', url: 'http://127.0.0.1:4780' })
  expect(settings.saved).toEqual({ mode: 'remote', url: 'http://127.0.0.1:4780' })
  expect(calls).toContain('close:attached')
  expect(calls).not.toContain('close:local')
  await manager.close()
  expect(calls).toContain('close:local')
})

test('switches a restored remote connection back to a newly established local server', async () => {
  const { manager, calls, settings } = fixture({ mode: 'remote', url: 'https://one.example' })
  await manager.start()
  calls.length = 0
  await expect(manager.setTarget({ mode: 'local' })).resolves.toEqual({ target: { mode: 'local' }, url: 'http://127.0.0.1:4780' })
  expect(settings.saved).toEqual({ mode: 'local' })
  expect(calls).toEqual([
    'connect:local',
    'activity:http://127.0.0.1:4780',
    'reconnect:http://127.0.0.1:4780',
    'stop:https://one.example',
    'close:one'
  ])
})

test('keeps the active connection and preference when probing or reconnect setup fails', async () => {
  const { manager, settings, calls, reconnect } = fixture({ mode: 'local' })
  await manager.start()
  await expect(manager.setTarget({ mode: 'remote', url: 'https://missing.example' })).rejects.toThrow('No Anvil server')
  expect(manager.state()).toEqual({ target: { mode: 'local' }, url: 'http://127.0.0.1:4780' })
  expect(settings.saved).toEqual({ mode: 'local' })
  expect(reconnect).not.toHaveBeenCalled()

  reconnect.mockRejectedValueOnce(new Error('renderer setup failed'))
  await expect(manager.setTarget({ mode: 'remote', url: 'https://one.example' })).rejects.toThrow('renderer setup failed')
  expect(manager.state()).toEqual({ target: { mode: 'local' }, url: 'http://127.0.0.1:4780' })
  expect(settings.saved).toEqual({ mode: 'local' })
  expect(calls).toContain('stop:https://one.example')
  expect(calls).toContain('close:one')
  expect(calls).not.toContain('close:local')
})

test('removes a newly written preference when rollback started without a saved choice', async () => {
  const { manager, settings, reconnect } = fixture()
  await manager.start()
  reconnect.mockRejectedValueOnce(new Error('renderer setup failed'))
  await expect(manager.setTarget({ mode: 'remote', url: 'https://one.example' })).rejects.toThrow('renderer setup failed')
  expect(settings.saved).toBeUndefined()
  expect(settings.calls.slice(-2)).toEqual(['save:remote', 'clear'])
})

test('serializes concurrent target changes', async () => {
  const { manager, calls, connect } = fixture({ mode: 'local' })
  await manager.start()
  calls.length = 0
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  connect.mockImplementationOnce(async () => {
    calls.push('connect:held')
    await gate
    return connection('https://one.example', calls, 'one')
  })
  const first = manager.setTarget({ mode: 'remote', url: 'https://one.example' })
  const second = manager.setTarget({ mode: 'remote', url: 'https://two.example' })
  await vi.waitFor(() => expect(calls).toContain('connect:held'))
  expect(connect).toHaveBeenCalledTimes(2)
  release()
  await Promise.all([first, second])
  expect(manager.state()).toEqual({ target: { mode: 'remote', url: 'https://two.example' }, url: 'https://two.example' })
  expect(calls.indexOf('reconnect:https://one.example')).toBeLessThan(calls.indexOf('connect:https://two.example'))
})

test('can establish and persist a local recovery target after startup failure', async () => {
  const { manager, settings } = fixture({ mode: 'remote', url: 'https://missing.example' })
  await expect(manager.start()).rejects.toThrow('No Anvil server')
  await expect(manager.start({ mode: 'local' }, true)).resolves.toEqual({ target: { mode: 'local' }, url: 'http://127.0.0.1:4780' })
  expect(settings.saved).toEqual({ mode: 'local' })
})
