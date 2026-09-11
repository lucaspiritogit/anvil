import { spawn, type ChildProcess } from 'node:child_process'
import { serverAddress } from '../../shared/server-address'

export interface ServerConnection {
  url: string
  close(): Promise<void>
}

async function checkHealth(url: string): Promise<void> {
  const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) })
  const health = await response.json() as { ok?: boolean; version?: string }
  if (!response.ok || health.ok !== true || typeof health.version !== 'string') throw new Error('Invalid Anvil server health response')
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
    await checkHealth(url)
    return { url, close: async () => {} }
  }
  const url = serverAddress(`http://127.0.0.1:${environment.ANVIL_SERVER_PORT ?? 4780}`)
  const child = spawn(options.executable, [options.entry], {
    env: { ...environment, ELECTRON_RUN_AS_NODE: '1', ANVIL_DATA_DIR: options.dataDirectory,
      ANVIL_PACKAGED: options.packaged ? '1' : '0', ANVIL_RENDERER_ORIGIN: new URL(options.rendererUrl).origin },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc']
  })
  let stopped: Promise<void> | undefined
  const close = (): Promise<void> => { stopped ??= stopChild(child); return stopped }
  try {
    // A ready message identifies our child; a different process on this port is not adopted.
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
    await checkHealth(url)
    return { url, close }
  } catch (error) {
    await close()
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
