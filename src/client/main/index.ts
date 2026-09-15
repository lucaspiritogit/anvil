import { app, BrowserWindow, dialog, Menu, shell, powerSaveBlocker, WebContentsView } from 'electron'
import { showNotificationSettings } from './mac-notifications'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { createDesktopIpc, openExternalCodexLogin, openExternalPullRequest, protectRendererWindow } from './renderer-security'
import { registerAppShutdown } from './app-shutdown'
import { registerCaffeineMode } from './caffeine-mode'
import { createServerCaffeineActivity } from './server-activity'
import { ServerConnectionManager, type ServerConnectionState } from './server-connection-manager'
import { ServerConnectionSettings } from './server-connection-settings'
import { connectToServer } from './server-process'
import { resolveAppDataDirectory } from '../../shared/app-data'
import type { ServerTarget } from '../../shared/server-address'
import { BrowserSessionManager } from './browser-sessions'
import { BrowserToolServer } from './browser-tools'

const dataDirectory = resolveAppDataDirectory(app.getPath('home'), app.isPackaged, process.env.ANVIL_DATA_DIR)
if (!app.isPackaged || process.env.ANVIL_DATA_DIR) {
  const profileDirectory = join(dataDirectory, 'electron')
  mkdirSync(profileDirectory, { recursive: true })
  app.setPath('userData', profileDirectory)
}
if (!app.isPackaged) app.setName('Anvil Dev')

const developmentRendererUrl = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
  ? process.env.ELECTRON_RENDERER_URL
  : ''
let rendererUrl = developmentRendererUrl
let mainWindow: BrowserWindow | null = null
let pendingWindow: BrowserWindow | null = null
let pendingRendererUrl = ''
let creatingWindow: Promise<void> | undefined
let isClosing = (): boolean => false
const browserViews = new Set<WebContentsView>()
const browserSessions = new BrowserSessionManager({
  create(webPreferences) {
    const view = new WebContentsView({ webPreferences })
    browserViews.add(view)
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.addChildView(view)
    return view
  },
  remove(view) {
    browserViews.delete(view as WebContentsView)
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.contentView.removeChildView(view as WebContentsView)
  }
}, (state) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('desktop:browser-changed', state)
})
const browserTools = new BrowserToolServer(browserSessions)

function rendererAddress(url: string): string {
  return developmentRendererUrl || `${url}/`
}

function createRendererWindow(state: ServerConnectionState): BrowserWindow {
  const targetRendererUrl = rendererAddress(state.url)
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0d0f12',
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: process.platform === 'darwin' ? { x: 14, y: 19 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      additionalArguments: [`--anvil-server-url=${state.url}`],
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  window.on('close', (event) => { if (isClosing()) event.preventDefault() })
  window.on('closed', () => {
    if (mainWindow !== window) return
    for (const view of browserViews) view.setVisible(false)
    mainWindow = null
  })
  protectRendererWindow(window, targetRendererUrl)
  return window
}

async function replaceRenderer(state: ServerConnectionState): Promise<void> {
  const nextRendererUrl = rendererAddress(state.url)
  const nextWindow = createRendererWindow(state)
  pendingWindow = nextWindow
  pendingRendererUrl = nextRendererUrl
  try {
    await nextWindow.loadURL(nextRendererUrl)
  } catch (error) {
    pendingWindow = null
    pendingRendererUrl = ''
    if (!nextWindow.isDestroyed()) nextWindow.destroy()
    throw new Error(`Could not load the Anvil client from ${nextRendererUrl}.`, { cause: error })
  }
  browserSessions.closeAll()
  const previousWindow = mainWindow
  rendererUrl = nextRendererUrl
  mainWindow = nextWindow
  pendingWindow = null
  pendingRendererUrl = ''
  if (previousWindow && !previousWindow.isDestroyed()) previousWindow.destroy()
  nextWindow.show()
  nextWindow.webContents.send('settings:open-requested')
}

const connectionSettings = new ServerConnectionSettings(app.getPath('userData'))
const connectionManager = new ServerConnectionManager({
  settings: connectionSettings,
  connect: (target) => connectToServer({
    executable: process.execPath,
    entry: join(__dirname, '../server/index.js'),
    dataDirectory,
    rendererOrigin: developmentRendererUrl ? new URL(developmentRendererUrl).origin : undefined,
    packaged: app.isPackaged,
    browserHost: browserTools,
    target
  }),
  reconnect: replaceRenderer,
  startActivity: (url) => registerCaffeineMode(createServerCaffeineActivity(url), powerSaveBlocker),
  reportCleanupError: (error) => console.error('Could not clean up the previous Anvil server connection:', error)
})

async function createWindow(openSettingsOnLoad = false): Promise<void> {
  if (creatingWindow || mainWindow) return creatingWindow
  creatingWindow = (async () => {
    const state = connectionManager.state()
    const window = createRendererWindow(state)
    mainWindow = window
    rendererUrl = rendererAddress(state.url)
    for (const view of browserViews) {
      window.contentView.addChildView(view)
      view.setVisible(false)
    }
    try {
      await window.loadURL(rendererUrl)
      if (!window.isDestroyed()) {
        window.show()
        if (openSettingsOnLoad) window.webContents.send('settings:open-requested')
      }
    } catch (error) {
      if (mainWindow === window) mainWindow = null
      if (!window.isDestroyed()) window.destroy()
      throw error
    }
  })().finally(() => { creatingWindow = undefined })
  return creatingWindow
}

function openSettings(): void {
  if (isClosing()) return
  if (!mainWindow) {
    void createWindow(true).catch((error) => console.error('Could not open Anvil:', error))
    return
  }
  const window = mainWindow
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  const request = (): void => {
    if (!window.isDestroyed()) window.webContents.send('settings:open-requested')
  }
  if (window.webContents.isLoadingMainFrame()) window.webContents.once('did-finish-load', request)
  else request()
}

async function showClosingProcesses(): Promise<void> {
  const closingWindow = new BrowserWindow({
    width: 320, height: 140, show: false, frame: false, resizable: false,
    backgroundColor: '#0d0f12', alwaysOnTop: true,
    ...(mainWindow && !mainWindow.isDestroyed() ? { parent: mainWindow, modal: true } : {}),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  closingWindow.on('close', (event) => { if (isClosing()) event.preventDefault() })
  const closingWindowReady = new Promise<void>((resolve) => {
    closingWindow.once('ready-to-show', () => {
      if (!closingWindow.isDestroyed()) closingWindow.show()
      resolve()
    })
  })
  const closingUrl = new URL('closing.html', rendererUrl).href
  try {
    await closingWindow.loadURL(closingUrl)
    await closingWindowReady
  } catch (error) {
    console.warn('Could not show closing window:', error)
  }
}

async function startConnection(): Promise<ServerConnectionState | undefined> {
  let target: ServerTarget | undefined
  let persist = false
  while (true) {
    try {
      return await connectionManager.start(target, persist)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const { response } = await dialog.showMessageBox({
        type: 'error',
        title: 'Anvil server unavailable',
        message: 'Anvil could not connect to its configured server.',
        detail: `${message}\n\nRetry the saved server, or reset this client to its built-in local server.`,
        buttons: ['Retry', 'Use Local Server', 'Quit'],
        defaultId: 0,
        cancelId: 2
      })
      if (response === 2) {
        app.quit()
        return undefined
      }
      if (response === 1) {
        target = { mode: 'local' }
        persist = true
      }
    }
  }
}

const ownsInstance = app.requestSingleInstanceLock()
if (!ownsInstance) app.quit()

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

if (ownsInstance) app.whenReady().then(async () => {
  try {
    const state = await startConnection()
    if (!state) return
    rendererUrl = rendererAddress(state.url)
    isClosing = registerAppShutdown(app, {
      showClosing: showClosingProcesses,
      cleanup: [() => browserTools.close(), () => connectionManager.close()],
      finalize: () => {},
      reportError: (error) => console.error('Could not stop Anvil server:', error)
    })
    process.on('SIGINT', () => app.quit())
    process.on('SIGTERM', () => app.quit())
    const desktop = createDesktopIpc(() => [
      ...(mainWindow ? [{ window: mainWindow, url: rendererUrl }] : []),
      ...(pendingWindow ? [{ window: pendingWindow, url: pendingRendererUrl }] : [])
    ])
    desktop.handle('desktop:pick-project', async () => {
      const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
      return result.canceled ? null : result.filePaths[0] ?? null
    })
    desktop.handle('desktop:pick-wallpaper', async () => {
      const result = await dialog.showOpenDialog({ title: 'Add wallpaper', properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] })
      return result.canceled ? null : result.filePaths[0] ?? null
    })
    desktop.handle('desktop:open-path', (path) => shell.openPath(path))
    desktop.handle('desktop:open-pr-url', openExternalPullRequest)
    desktop.handle('desktop:open-login-url', openExternalCodexLogin)
    desktop.handle('desktop:browser-state', (taskId) => browserSessions.state(taskId))
    desktop.handle('desktop:browser-layout', (layout) => browserSessions.layout(layout))
    desktop.handle('desktop:browser-viewport', (input) => browserSessions.viewport(input.taskId, input.viewport))
    desktop.handle('desktop:server-target', () => connectionManager.state())
    desktop.handle('desktop:set-server-target', (target) => connectionManager.setTarget(target))
    await createWindow()
    const settingsMenu = { label: 'Settings…', accelerator: 'CommandOrControl+,', click: openSettings }
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ label: app.name, submenu: [
        { role: 'about' as const }, { type: 'separator' as const }, settingsMenu,
        { label: 'Notifications…', click: () => { void showNotificationSettings().catch(console.warn) } },
        { type: 'separator' as const }, { role: 'services' as const },
        { type: 'separator' as const }, { role: 'hide' as const }, { role: 'hideOthers' as const },
        { role: 'unhide' as const }, { type: 'separator' as const }, { role: 'quit' as const }
      ] }] : [{ label: 'File', submenu: [settingsMenu, { role: 'quit' as const }] }]),
      { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }
    ]))
    app.on('activate', () => {
      if (!isClosing() && !mainWindow) void createWindow().catch((error) => console.error('Could not open Anvil:', error))
    })
  } catch (error) {
    console.error('Could not start Anvil:', error)
    dialog.showErrorBox('Anvil failed to start', error instanceof Error ? error.message : String(error))
    app.quit()
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
