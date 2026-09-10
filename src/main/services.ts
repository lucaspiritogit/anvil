import type { BrowserWindow } from 'electron'
import { registerIpc } from './ipc'
import { restoreShellPath } from './shell-path'

export type Services = ReturnType<typeof registerIpc>

/** Restore the login-shell PATH while constructing the app services. */
export function initializeServices(
  getWindow: () => BrowserWindow | null,
  rendererUrl: string,
  dataDirectory: string
): Promise<Services> {
  const shellPathReady = restoreShellPath()
  const services = registerIpc(getWindow, rendererUrl, dataDirectory)
  return shellPathReady.then(() => services)
}
