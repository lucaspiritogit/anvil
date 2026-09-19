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
