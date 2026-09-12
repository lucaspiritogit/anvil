import { join } from 'node:path'
import { homedir, networkInterfaces } from 'node:os'
import { createAnvilRuntime } from './runtime'
import { createAnvilHttpServer } from './http'
import { resolveAppDataDirectory } from '../shared/app-data'
import { restoreShellPath } from './shell-path'
import { version } from '../../package.json'
import { ServerAuth } from './server-auth'
import { createTailscaleConnection } from './tailscale'
import type { HttpRuntime } from './http'
import { configureHeadlessPassword } from './headless-password'
import type { HeadlessAccessMode } from '../shared/types'

async function main(): Promise<void> {
  const tailscaleOnly = process.argv.includes('--tailscale')
  const headlessAccess: HeadlessAccessMode | undefined = tailscaleOnly
    ? 'tailscale'
    : process.argv.includes('--headless') ? 'password' : undefined
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
    auth: serverAuth,
    requireAuthentication: headlessAccess === 'password'
  }
  const http = createAnvilHttpServer(httpRuntime, httpOptions)
  let tailscaleHttp: ReturnType<typeof createAnvilHttpServer> | undefined
  const tailscale = createTailscaleConnection({
    async start(origin) {
      tailscaleHttp = createAnvilHttpServer(httpRuntime, {
        ...httpOptions,
        // Tailscale connects to this loopback listener after enforcing tailnet access.
        requireAuthentication: !tailscaleOnly,
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
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const deadline = setTimeout(() => process.exit(1), 8_000)
      try {
        const results = await Promise.allSettled([http.close(), runtime ? runtime.close() : tailscale.close()])
        const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason)
        if (errors.length) throw new AggregateError(errors, 'Could not stop Anvil server')
      } finally {
        clearTimeout(deadline)
      }
    })()
    return closing
  }
  const exitAfterCleanup = (code: number): void => {
    void close().then(() => process.exit(code), (error) => {
      console.error(error)
      process.exit(1)
    })
  }
  const stop = (): void => { exitAfterCleanup(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  process.on('SIGHUP', stop)
  process.on('disconnect', stop)
  if (tailscaleOnly) {
    tailscale.onStopped((message) => {
      console.error(message)
      exitAfterCleanup(1)
    })
  }
  try {
    const url = await http.listen(port)
    if (headlessAccess === 'password') await configureHeadlessPassword(serverAuth)
    // Reserve the port before opening storage. A second server must never recover
    // tasks in a live server's database merely because its bind will fail later.
    runtime = createAnvilRuntime({
      dataDirectory,
      migrationsDirectory: join(__dirname, 'db', 'migrations'),
      memoryMigrationsDirectory: join(__dirname, 'memory', 'migrations'),
      serverAuth,
      rebindHttp: http.rebind,
      tailscale,
      headlessAccess
    })
    runtime.subscribeAll((channel, payload) => {
      for (const listener of listeners) listener(channel, payload)
    })
    if (headlessAccess) {
      const status = await runtime.initializeConnections()
      if (status.tailscaleSetupUrl) console.error(`Complete Tailscale HTTPS setup: ${status.tailscaleSetupUrl}`)
      if (status.error) throw new Error(status.error)
      if (headlessAccess === 'tailscale') {
        if (!status.tailscaleUrl) throw new Error('Tailscale HTTPS did not start.')
        console.log(`Anvil Tailscale URL: ${status.tailscaleUrl}`)
        console.log('Access is managed by Tailscale. No Anvil username or password is required.')
      } else {
        if (!status.allowOtherDevices) throw new Error('Password-protected network access did not start.')
        for (const addresses of Object.values(networkInterfaces())) {
          for (const address of addresses ?? []) {
            if (address.family === 'IPv4' && !address.internal) console.log(`Anvil network URL: http://${address.address}:${port}`)
          }
        }
        console.log('Sign in with username anvil and your server password.')
      }
    } else {
      // HTTPS setup can wait on Tailscale. Keep the desktop available while it runs.
      void runtime.initializeConnections().catch((error) => console.error('Could not initialize connection settings:', error))
    }
    console.log(`Anvil server listening at ${url}`)
    process.send?.({ type: 'anvil-server-ready', url })
  } catch (error) {
    await close()
    throw error
  }
}

void main().catch((error) => { console.error('Could not start Anvil server:', error); process.exitCode = 1 })
