import { ipcMain, shell, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { IpcInvokeChannel, IpcSendChannel, IpcRequests } from '../shared/ipc-requests'
import { validateIpcRequest } from './ipc/validation'
import { isGitHubPullRequestUrl } from './github-repository'

/** Only the configured document may use the desktop bridge. Hash routes are local. */
export function isRendererUrl(value: string, rendererUrl: string): boolean {
  try {
    const url = new URL(value)
    const expected = new URL(rendererUrl)
    url.hash = ''
    expected.hash = ''
    return url.href === expected.href
  } catch {
    return false
  }
}

export function isRendererSender(
  event: IpcMainEvent | IpcMainInvokeEvent,
  window: BrowserWindow | null,
  rendererUrl: string
): boolean {
  if (!window || window.isDestroyed()) return false
  const contents = window.webContents
  return !contents.isDestroyed() && event.sender === contents &&
    event.senderFrame !== null && event.senderFrame === contents.mainFrame &&
    isRendererUrl(event.senderFrame.url, rendererUrl)
}

export interface RendererIpc {
  handle<C extends IpcInvokeChannel>(channel: C, listener: (event: IpcMainInvokeEvent, input: IpcRequests[C]) => unknown): void
  on<C extends IpcSendChannel>(channel: C, listener: (event: IpcMainEvent, input: IpcRequests[C]) => void): void
}

/** Register every privileged channel through this guard, including send-only events. */
export function createRendererIpc(
  getWindow: () => BrowserWindow | null,
  rendererUrl: string
): RendererIpc {
  return {
    handle(channel, listener) {
      ipcMain.handle(channel, (event, ...args) => {
        if (!isRendererSender(event, getWindow(), rendererUrl)) {
          throw new Error('Unauthorized IPC sender')
        }
        return listener(event, validateIpcRequest(channel, args))
      })
    },
    on(channel, listener) {
      ipcMain.on(channel, (event, ...args) => {
        // Send-only channels have no rejection reply; drop them without throwing in main.
        if (!isRendererSender(event, getWindow(), rendererUrl)) return
        try {
          listener(event, validateIpcRequest(channel, args))
        } catch (error) {
          // Do not log raw payloads, which can contain tokens or terminal input.
          console.warn(`Rejected ${channel}:`, error instanceof Error ? error.message : 'Invalid request')
        }
      })
    }
  }
}

export async function openExternalPullRequest(value: unknown): Promise<void> {
  if (typeof value !== 'string' || !isGitHubPullRequestUrl(value) || new URL(value).href !== value) {
    throw new Error('Invalid GitHub PR URL.')
  }
  try {
    await shell.openExternal(value)
  } catch (error) {
    throw new Error('Could not open the GitHub PR in your browser.', { cause: error })
  }
}

export function protectRendererWindow(window: BrowserWindow, rendererUrl: string): void {
  const contents = window.webContents
  contents.on('will-navigate', (event, url) => {
    if (!isRendererUrl(url, rendererUrl)) event.preventDefault()
  })
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame || !isRendererUrl(event.url, rendererUrl)) event.preventDefault()
  })
  contents.on('will-redirect', (event, url, _inPlace, isMainFrame) => {
    if (!isMainFrame || !isRendererUrl(url, rendererUrl)) event.preventDefault()
  })
  contents.setWindowOpenHandler(({ url }) => {
    void openExternalPullRequest(url).catch((error) => console.warn('External window denied or unavailable:', error.message))
    return { action: 'deny' }
  })
}
