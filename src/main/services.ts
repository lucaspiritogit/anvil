import { app, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { restoreShellPath } from './shell-path'
import { exposeValenceLauncher, installValenceLauncher } from './valence/launcher'

export type Services = ReturnType<typeof registerIpc>

/**
 * Starts the login-shell probe and the Valence launcher install concurrently
 * with the synchronous IPC service construction, then exposes the launcher and
 * resolves with the services object used for shutdown and listeners.
 */
export function initializeServices(
  getWindow: () => BrowserWindow | null,
  rendererUrl: string,
  dataDirectory: string
): Promise<Services> {
  const shellPathReady = restoreShellPath()
  const cliDirectory = join(app.getPath('userData'), 'bin')
  installValenceLauncher(cliDirectory, process.execPath, join(__dirname, 'valence-cli.js'), join(dataDirectory, 'config.json'))
  const services = registerIpc(getWindow, rendererUrl, dataDirectory)
  return shellPathReady.then(() => {
    exposeValenceLauncher(cliDirectory)
    return services
  })
}
