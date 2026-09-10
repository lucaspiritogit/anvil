import { expect, test, vi } from 'vitest'
import { APP_INIT_FAILED_CHANNEL, APP_READY_CHANNEL } from '../src/shared/app-lifecycle'
import { notifyRendererReady, startApplication, type ReadinessTarget } from '../src/main/startup'

class FakeWindow implements ReadinessTarget {
  destroyed = false
  loading: boolean
  sent: Array<{ channel: string; payload: unknown }> = []
  private loadListeners: Array<() => void> = []

  constructor(loading = false) {
    this.loading = loading
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  webContents = {
    isLoadingMainFrame: (): boolean => this.loading,
    once: (_event: 'did-finish-load', listener: () => void): void => {
      this.loadListeners.push(listener)
    },
    send: (channel: string, payload?: unknown): void => {
      this.sent.push({ channel, payload })
    }
  }

  finishLoad(): void {
    this.loading = false
    for (const listener of this.loadListeners.splice(0)) listener()
  }
}

test('creates the window before service initialization starts', async () => {
  const order: string[] = []
  const window = new FakeWindow()
  let resolveServices!: (services: string) => void
  const started = startApplication({
    createWindow: () => order.push('window'),
    initializeServices: () => {
      order.push('services')
      return new Promise<string>((resolve) => { resolveServices = resolve })
    },
    getWindow: () => window,
    onServicesReady: () => order.push('ready'),
    onInitFailed: vi.fn()
  })

  expect(order).toEqual(['window', 'services'])
  resolveServices('services-object')
  await expect(started).resolves.toBe('services-object')
  expect(order).toEqual(['window', 'services', 'ready'])
})

test('queues readiness until the main frame finishes loading', async () => {
  const window = new FakeWindow(true)
  const services = await startApplication({
    createWindow: vi.fn(),
    initializeServices: async () => 'services-object',
    getWindow: () => window,
    onServicesReady: vi.fn(),
    onInitFailed: vi.fn()
  })

  expect(services).toBe('services-object')
  expect(window.sent).toEqual([])
  window.finishLoad()
  expect(window.sent).toEqual([{ channel: APP_READY_CHANNEL, payload: { ok: true } }])
})

test('sends readiness immediately once the frame has loaded', async () => {
  const window = new FakeWindow(false)
  await startApplication({
    createWindow: vi.fn(),
    initializeServices: async () => 'services-object',
    getWindow: () => window,
    onServicesReady: vi.fn(),
    onInitFailed: vi.fn()
  })

  expect(window.sent).toEqual([{ channel: APP_READY_CHANNEL, payload: { ok: true } }])
})

test('surfaces an initialization failure without registering ready services', async () => {
  const window = new FakeWindow(false)
  const onServicesReady = vi.fn()
  const onInitFailed = vi.fn()
  const error = new Error('migration failed')

  const services = await startApplication({
    createWindow: vi.fn(),
    initializeServices: async () => { throw error },
    getWindow: () => window,
    onServicesReady,
    onInitFailed
  })

  expect(services).toBeUndefined()
  expect(onServicesReady).not.toHaveBeenCalled()
  expect(onInitFailed).toHaveBeenCalledWith(error)
  expect(window.sent).toEqual([{
    channel: APP_INIT_FAILED_CHANNEL,
    payload: { ok: false, message: 'migration failed' }
  }])
})

test('queues a failure signal until the main frame finishes loading', async () => {
  const window = new FakeWindow(true)
  await startApplication({
    createWindow: vi.fn(),
    initializeServices: async () => { throw new Error('store failed to open') },
    getWindow: () => window,
    onServicesReady: vi.fn(),
    onInitFailed: vi.fn()
  })

  expect(window.sent).toEqual([])
  window.finishLoad()
  expect(window.sent).toEqual([{
    channel: APP_INIT_FAILED_CHANNEL,
    payload: { ok: false, message: 'store failed to open' }
  }])
})

test('a throwing failure reporter still resolves and posts the failure', async () => {
  const window = new FakeWindow(false)
  const services = await startApplication({
    createWindow: vi.fn(),
    initializeServices: async () => { throw new Error('window creation failed') },
    getWindow: () => window,
    onServicesReady: vi.fn(),
    onInitFailed: () => { throw new Error('dialog failed') }
  })

  expect(services).toBeUndefined()
  expect(window.sent).toEqual([{
    channel: APP_INIT_FAILED_CHANNEL,
    payload: { ok: false, message: 'window creation failed' }
  }])
})

test('does not send to a destroyed window', async () => {
  const window = new FakeWindow(false)
  window.destroyed = true
  await startApplication({
    createWindow: vi.fn(),
    initializeServices: async () => 'services-object',
    getWindow: () => window,
    onServicesReady: vi.fn(),
    onInitFailed: vi.fn()
  })

  expect(window.sent).toEqual([])
})

test('notifyRendererReady tolerates the absence of a window', () => {
  expect(() => notifyRendererReady(null, APP_READY_CHANNEL, { ok: true })).not.toThrow()
})
