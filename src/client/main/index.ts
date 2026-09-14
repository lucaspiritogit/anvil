import { app, BrowserWindow, dialog, Menu, shell, powerSaveBlocker, WebContentsView } from 'electron'
import { showNotificationSettings } from './mac-notifications'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { createDesktopIpc, openExternalCodexLogin, openExternalPullRequest, protectRendererWindow } from './renderer-security'
import { registerAppShutdown } from './app-shutdown'
import { registerCaffeineMode } from './caffeine-mode'
import { createServerCaffeineActivity } from './server-activity'
import { connectToServer } from './server-process'
import { resolveAppDataDirectory } from '../../shared/app-data'
import { BrowserSessionManager } from './browser-sessions'
import { BrowserToolServer } from './browser-tools'

const dataDirectory = resolveAppDataDirectory(app.getPath('home'), app.isPackaged, process.env.ANVIL_DATA_DIR)
if (!app.isPackaged || process.env.ANVIL_DATA_DIR) {
  // Configure the profile before acquiring Electron's single-instance lock.
  const profileDirectory = join(dataDirectory, 'electron')
  mkdirSync(profileDirectory, { recursive: true })
  app.setPath('userData', profileDirectory)
}
if (!app.isPackaged) app.setName('Anvil Dev')

// In development the window loads the Vite dev server; otherwise it loads the
// UI served over HTTP by the Anvil server once the connection is established.
let rendererUrl = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
  ? process.env.ELECTRON_RENDERER_URL
  : ''

let mainWindow: BrowserWindow | null = null
let serverUrl = ''
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
function openSettings(): void {
  if (isClosing()) return
  if (!mainWindow) {
    createWindow(true)
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
      if (!closingWindow.isDestroyed()) {
        closingWindow.show()
      }
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

function createWindow(openSettingsOnLoad = false): void {
  mainWindow = new BrowserWindow({
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
      additionalArguments: [`--anvil-server-url=${serverUrl}`],
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (event) => { if (isClosing()) event.preventDefault() })
  mainWindow.on('closed', () => {
    for (const view of browserViews) view.setVisible(false)
    mainWindow = null
  })

  for (const view of browserViews) {
    mainWindow.contentView.addChildView(view)
    view.setVisible(false)
  }

  protectRendererWindow(mainWindow, rendererUrl)
  const window = mainWindow
  void window.loadURL(rendererUrl).then(() => {
    if (openSettingsOnLoad && !window.isDestroyed()) window.webContents.send('settings:open-requested')
  })
}

const ownsInstance = app.requestSingleInstanceLock()
if (!ownsInstance) {
  app.quit()
}

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

if (ownsInstance) app.whenReady().then(async () => {
  try {
    const connection = await connectToServer({
      executable: process.execPath,
      entry: join(__dirname, '../server/index.js'),
      dataDirectory,
      rendererOrigin: rendererUrl ? new URL(rendererUrl).origin : undefined,
      packaged: app.isPackaged,
      browserHost: browserTools
    })
    serverUrl = connection.url
    if (!rendererUrl) rendererUrl = `${serverUrl}/`
    const stopCaffeineMode = registerCaffeineMode(createServerCaffeineActivity(serverUrl), powerSaveBlocker)
    isClosing = registerAppShutdown(app, {
      showClosing: showClosingProcesses,
      cleanup: [stopCaffeineMode, () => browserTools.close(), () => connection.close()],
      finalize: () => {},
      reportError: (error) => console.error('Could not stop Anvil server:', error)
    })
    process.on('SIGINT', () => app.quit())
    process.on('SIGTERM', () => app.quit())
    const desktop = createDesktopIpc(() => mainWindow, rendererUrl)
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
    createWindow()
    const settingsMenu = {
      label: 'Settings…', accelerator: 'CommandOrControl+,',
      click: openSettings
    }
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
      if (!isClosing() && !mainWindow) createWindow()
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
