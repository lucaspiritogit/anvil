import { _electron } from '@playwright/test'
import { createServer } from 'node:net'

export { expect } from '@playwright/test'

const ports = new Map()

/** A profile must never attach to the developer's running Anvil server. */
export async function isolatedServerPort(key) {
  if (!ports.has(key)) {
    const listener = createServer()
    await new Promise((resolve, reject) => {
      listener.once('error', reject)
      listener.listen(0, '127.0.0.1', resolve)
    })
    const port = listener.address().port
    await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))
    ports.set(key, String(port))
  }
  return ports.get(key)
}

export const electron = {
  async launch(options) {
    const env = { ...process.env, ...options.env }
    if (!env.ANVIL_DATA_DIR && !options.env?.HOME) throw new Error('Electron checks require an isolated profile')
    const key = `${env.ANVIL_DATA_DIR ?? env.HOME}:${options.executablePath ?? 'development'}`
    env.ANVIL_SERVER_PORT = await isolatedServerPort(key)
    delete env.ANVIL_SQLITE_BINDING
    delete env.ANVIL_SERVER_URL
    delete env.ELECTRON_RUN_AS_NODE
    return _electron.launch({ ...options, env })
  }
}
