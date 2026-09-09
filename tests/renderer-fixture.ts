import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { createRendererIpc } from '../src/main/renderer-security'

export const rendererUrl = 'http://localhost:5173/'
export const rendererFrame = { url: rendererUrl }
export const rendererContents = { mainFrame: rendererFrame, isDestroyed: () => false, send: () => {} }
export const rendererWindow = { webContents: rendererContents, isDestroyed: () => false } as unknown as BrowserWindow
export const getRendererWindow = (): BrowserWindow => rendererWindow
export const rendererEvent = { sender: rendererContents, senderFrame: rendererFrame } as unknown as IpcMainInvokeEvent
export const rendererIpc = createRendererIpc(getRendererWindow, rendererUrl)
