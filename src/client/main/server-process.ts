import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { serverAddress } from '../../shared/server-address'

export interface ServerConnection {
  url: string
  close(): Promise<void>
}

function connectionRefused(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  if ('code' in error && error.code === 'ECONNREFUSED') return true
  return 'cause' in error && connectionRefused(error.cause)
}

async function existingServer(url: string): Promise<ServerConnection | undefined> {
  const deadline = Date.now() + 20_000
  while (true) {
    let response: Response
    try {
      response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000), redirect: 'error' })
    } catch (error) {
      if (connectionRefused(error)) return undefined
      throw new Error(`Could not connect to Anvil at ${url}.`, { cause: error })
    }
    const health: unknown = await response.json().catch(() => null)
    if (!response.ok || !health || typeof health !== 'object' ||
      !('service' in health) || health.service !== 'anvil' ||
      !('ok' in health) || health.ok !== true ||
      !('version' in health) || typeof health.version !== 'string' ||
      !('ready' in health) || typeof health.ready !== 'boolean') {
      throw new Error(`The service at ${url} is not a compatible Anvil server. Stop it or use another ANVIL_SERVER_PORT.`)
    }
    if (health.ready) return { url, close: async () => {} }
    if (Date.now() >= deadline) throw new Error(`Anvil at ${url} is still starting. Finish any setup in its terminal, then reopen the app.`)
    await delay(200)
  }
}

export async function connectToServer(options: {
  executable: string
  entry: string
  dataDirectory: string
  rendererUrl: string
  packaged: boolean
  environment?: NodeJS.ProcessEnv
}): Promise<ServerConnection> {
  const environment = options.environment ?? process.env
  if (environment.ANVIL_SERVER_URL) {
    const url = serverAddress(environment.ANVIL_SERVER_URL)
    const existing = await existingServer(url)
    if (!existing) throw new Error(`No Anvil server is running at ${url}.`)
    return existing
  }
  const url = serverAddress(`http://127.0.0.1:${environment.ANVIL_SERVER_PORT ?? 4780}`)
  const existing = await existingServer(url)
  if (existing) return existing
  const child = spawn(options.executable, [options.entry], {
    env: { ...environment, ELECTRON_RUN_AS_NODE: '1', ANVIL_DATA_DIR: options.dataDirectory,
      ANVIL_PACKAGED: options.packaged ? '1' : '0', ANVIL_RENDERER_ORIGIN: new URL(options.rendererUrl).origin },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  })
  let stopped: Promise<void> | undefined
  const close = (): Promise<void> => { stopped ??= stopChild(child); return stopped }
  try {
    // Only a child we started belongs to the desktop's shutdown lifecycle.
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('Timed out starting Anvil server')), 20_000)
      const onError = (error: Error): void => finish(error)
      const onExit = (code: number | null): void => finish(new Error(`Anvil server exited during startup (${code})`))
      const onMessage = (message: unknown): void => {
        if (message && typeof message === 'object' && 'type' in message && message.type === 'anvil-server-ready' && 'url' in message && message.url === url) finish()
      }
      const finish = (error?: Error): void => {
        clearTimeout(timeout)
        child.off('error', onError)
        child.off('exit', onExit)
        child.off('message', onMessage)
        if (error) reject(error)
        else resolve()
      }
      child.once('error', onError)
      child.once('exit', onExit)
      child.on('message', onMessage)
    })
    if (!await existingServer(url)) throw new Error('Anvil server stopped during startup.')
    return { url, close }
  } catch (error) {
    await close()
    // Another launch may have claimed the port after our initial probe.
    const existing = await existingServer(url)
    if (existing) return existing
    throw error
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => child.kill('SIGKILL'), 7_000)
    child.once('exit', () => { clearTimeout(timeout); resolve() })
    child.kill('SIGTERM')
  })
}
