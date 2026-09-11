import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { createHandlerRegistry, type HandlerRegistry } from '../src/server/handler-registry'
import { handlers } from './issue-tracker-doubles'

export const rendererUrl = 'http://localhost:5173/'
export const rendererFrame = { url: rendererUrl }
export const rendererContents = { mainFrame: rendererFrame, isDestroyed: () => false, send: (_channel: string, _payload: unknown) => {} }
export const rendererWindow = { webContents: rendererContents, isDestroyed: () => false } as unknown as BrowserWindow
export const getRendererWindow = (): BrowserWindow => rendererWindow
export const rendererEvent = { sender: rendererContents, senderFrame: rendererFrame } as unknown as IpcMainInvokeEvent
export const rendererIpc: HandlerRegistry = {
  handle(channel, listener) {
    const registry = createHandlerRegistry()
    registry.handle(channel, listener)
    handlers.set(channel, (_event, ...args) => {
      if (args.length > 1) throw new Error('Invalid IPC request: too many arguments')
      return registry.invoke(channel, args[0])
    })
  },
  on(channel, listener) { this.handle(channel, listener) }
}
