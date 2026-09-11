import { contextBridge, ipcRenderer } from 'electron'
import { createAnvilApi } from './api'
import { serverAddress } from '../../shared/server-address'

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
  pickProject: () => ipcRenderer.invoke('desktop:pick-project'),
  pickWallpaper: () => ipcRenderer.invoke('desktop:pick-wallpaper'),
  openPath: (path) => ipcRenderer.invoke('desktop:open-path', path),
  openPullRequest: (value) => ipcRenderer.invoke('desktop:open-pr-url', value),
  openLoginUrl: (value) => ipcRenderer.invoke('desktop:open-login-url', value)
})

contextBridge.exposeInMainWorld('anvil', api)

export type { AnvilApi } from './api'
