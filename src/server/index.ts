import { join } from 'node:path'
import { homedir } from 'node:os'
import { createAnvilRuntime } from './runtime'
import { createAnvilHttpServer } from './http'
import { resolveAppDataDirectory } from '../shared/app-data'
import { restoreShellPath } from './shell-path'
import { version } from '../../package.json'
import { ServerAuth } from './server-auth'
import { createTailscaleConnection } from './tailscale'
import type { HttpRuntime } from './http'

async function main(): Promise<void> {
  const port = Number(process.env.ANVIL_SERVER_PORT ?? 4780)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('ANVIL_SERVER_PORT must be between 1 and 65535')
  await restoreShellPath()
  const dataDirectory = resolveAppDataDirectory(homedir(), process.env.ANVIL_PACKAGED === '1', process.env.ANVIL_DATA_DIR)
  const serverAuth = new ServerAuth(dataDirectory)
  let runtime: ReturnType<typeof createAnvilRuntime> | undefined
  const listeners = new Set<(channel: string, payload: unknown) => void>()
  const httpRuntime: HttpRuntime = {
    invoke: (channel, input, context) => {
      if (!runtime) throw new Error('Anvil server is starting')
      return runtime.invoke(channel, input, context)
    },
    subscribeAll: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
  }
  const httpOptions = {
    version,
    rendererOrigin: process.env.ANVIL_RENDERER_ORIGIN ?? 'http://localhost:5173',
    rendererDirectory: join(__dirname, '../browser'),
    auth: serverAuth
  }
  const http = createAnvilHttpServer(httpRuntime, httpOptions)
  let tailscaleHttp: ReturnType<typeof createAnvilHttpServer> | undefined
  const tailscale = createTailscaleConnection({
    async start(origin) {
      tailscaleHttp = createAnvilHttpServer(httpRuntime, {
        ...httpOptions,
        requireAuthentication: true,
        externalOrigin: origin
      })
      return tailscaleHttp.listen(0)
    },
    async stop() {
      const active = tailscaleHttp
      tailscaleHttp = undefined
      await active?.close()
    }
  })
  let closing = false
  const close = async (): Promise<void> => {
    if (closing) return
    closing = true
    const deadline = setTimeout(() => process.exit(1), 8_000)
    try {
      const results = await Promise.allSettled([http.close(), runtime?.close()])
      const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
      if (errors.length) throw new AggregateError(errors, 'Could not stop Anvil server')
    } finally {
      clearTimeout(deadline)
    }
  }
  const stop = (): void => { void close().then(() => process.exit(0), (error) => { console.error(error); process.exit(1) }) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  process.on('disconnect', stop)
  try {
    const url = await http.listen(port)
    // Reserve the port before opening storage. A second server must never recover
    // tasks in a live server's database merely because its bind will fail later.
    runtime = createAnvilRuntime({
      dataDirectory,
      migrationsDirectory: join(__dirname, 'db', 'migrations'),
      memoryMigrationsDirectory: join(__dirname, 'memory', 'migrations'),
      serverAuth,
      rebindHttp: http.rebind,
      tailscale
    })
    runtime.subscribeAll((channel, payload) => {
      for (const listener of listeners) listener(channel, payload)
    })
    // HTTPS setup can wait on Tailscale. Keep the desktop available while it runs.
    void runtime.initializeConnections().catch((error) => console.error('Could not initialize connection settings:', error))
    console.log(`Anvil server listening at ${url}`)
    process.send?.({ type: 'anvil-server-ready', url })
  } catch (error) {
    await close()
    throw error
  }
}

void main().catch((error) => { console.error('Could not start Anvil server:', error); process.exitCode = 1 })
