import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { createAnvilApi } from '@anvil/client-api'
import { serverAddress } from '@anvil/protocol/server-address'
import type { BrowserObservationState } from '@anvil/protocol/browser-observation'

// Keep native-menu requests made while React is still loading.
let settingsOpenPending = false
let settingsOpenHandler: (() => void) | undefined
ipcRenderer.on('settings:open-requested', () => {
  if (settingsOpenHandler) settingsOpenHandler()
  else settingsOpenPending = true
})

const argument = process.argv.find((value) => value.startsWith('--anvil-server-url='))
const url = serverAddress(argument?.slice('--anvil-server-url='.length) ?? 'http://127.0.0.1:4780')
const api = createAnvilApi(url, {
  platform: process.platform,
  onSettingsOpen(handler) {
    settingsOpenHandler = handler
    if (settingsOpenPending) {
      settingsOpenPending = false
      handler()
    }
    return () => { if (settingsOpenHandler === handler) settingsOpenHandler = undefined }
  },
  pickWallpaper: () => ipcRenderer.invoke('desktop:pick-wallpaper'),
  pickProjectFolder: async () => {
    const selected = await ipcRenderer.invoke('desktop:pick-project-folder') as { name: string; path: string } | {
      token: string
      name: string
      entries: Array<{ path: string; type: 'file' | 'directory'; size: number; executable?: boolean }>
    } | null
    if (!selected) return null
    if ('path' in selected) return selected
    return {
      name: selected.name,
      entries: selected.entries.map((entry, index) => ({
        ...entry,
        ...(entry.type === 'file' ? {
          read: (offset: number, length: number): Promise<Uint8Array> => ipcRenderer.invoke(
            'desktop:read-project-file',
            { token: selected.token, index, offset, length }
          )
        } : {})
      })),
      dispose: (): Promise<void> => ipcRenderer.invoke('desktop:release-project-folder', selected.token)
    }
  },
  openPath: (path) => ipcRenderer.invoke('desktop:open-path', path),
  openPullRequest: (value) => ipcRenderer.invoke('desktop:open-pr-url', value),
  openLoginUrl: (value) => ipcRenderer.invoke('desktop:open-login-url', value),
  browserState: (taskId) => ipcRenderer.invoke('desktop:browser-state', taskId),
  browserLayout: (layout) => ipcRenderer.invoke('desktop:browser-layout', layout),
  browserViewport: (input) => ipcRenderer.invoke('desktop:browser-viewport', input),
  serverTarget: () => ipcRenderer.invoke('desktop:server-target'),
  setServerTarget: (target) => ipcRenderer.invoke('desktop:set-server-target', target),
  onBrowserChanged(handler) {
    const listener = (_event: IpcRendererEvent, state: BrowserObservationState): void => handler(state)
    ipcRenderer.on('desktop:browser-changed', listener)
    return () => { ipcRenderer.off('desktop:browser-changed', listener) }
  }
})

contextBridge.exposeInMainWorld('anvil', api)

export type { AnvilApi } from '@anvil/client-api'
