import { app, BrowserWindow, dialog, Menu, powerMonitor } from 'electron'
import { showNotificationSettings } from './mac-notifications'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { protectRendererWindow } from './renderer-security'
import { registerAppShutdown } from './app-shutdown'
import { startApplication } from './startup'
import { APP_READY_CHANNEL } from '../shared/app-lifecycle'
import { initializeServices } from './services'
import { resolveAppDataDirectory } from './app-data'

const dataDirectory = resolveAppDataDirectory(app.getPath('home'), app.isPackaged, process.env.ANVIL_DATA_DIR)
if (!app.isPackaged || process.env.ANVIL_DATA_DIR) {
  // Configure the profile before acquiring Electron's single-instance lock.
  const profileDirectory = join(dataDirectory, 'electron')
  mkdirSync(profileDirectory, { recursive: true })
  app.setPath('userData', profileDirectory)
}
if (!app.isPackaged) app.setName('Anvil Dev')

const rendererUrl = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
  ? process.env.ELECTRON_RENDERER_URL
  : pathToFileURL(join(__dirname, '../renderer/index.html')).href

let mainWindow: BrowserWindow | null = null
let servicesReady = false
let isClosing = (): boolean => false
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

function showClosingProcesses(): void {
  // A native modal also works after the last main window has already closed.
  const closingWindow = new BrowserWindow({
    width: 320, height: 140, show: false, frame: false, resizable: false,
    backgroundColor: '#0d0f12', alwaysOnTop: true,
    ...(mainWindow && !mainWindow.isDestroyed() ? { parent: mainWindow, modal: true } : {}),
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  closingWindow.on('close', (event) => { if (isClosing()) event.preventDefault() })
  closingWindow.once('ready-to-show', () => closingWindow.show())
  void closingWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
    <style>
      body { margin: 0; height: 100vh; display: grid; place-content: center; gap: 16px; justify-items: center;
        background: #0d0f12; color: #e5e7eb; font: 14px system-ui; }
      .spinner { width: 20px; height: 20px; border: 2px solid #363b45; border-top-color: #e5e7eb;
        border-radius: 50%; animation: spin 0.8s linear infinite; }
      @keyframes spin { to { transform: rotate(360deg); } }
      @media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
    </style></head><body role="status" aria-live="polite"><div class="spinner" aria-hidden="true"></div>closing up processes...</body></html>
  `)}`).catch((error) => console.warn('Could not show closing window:', error))
}

function createWindow(openSettingsOnLoad = false): void {
  const restoringWindow = servicesReady
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
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (event) => { if (isClosing()) event.preventDefault() })
  mainWindow.on('closed', () => { mainWindow = null })

  protectRendererWindow(mainWindow, rendererUrl)
  const window = mainWindow
  void window.loadURL(rendererUrl).then(() => {
    // Startup signals the first window; restored windows need the same readiness.
    if (restoringWindow && !window.isDestroyed()) window.webContents.send(APP_READY_CHANNEL, { ok: true })
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

if (ownsInstance) app.whenReady().then(() => {
  void startApplication({
    createWindow: () => createWindow(),
    initializeServices: () => initializeServices(() => mainWindow, rendererUrl, dataDirectory),
    getWindow: () => mainWindow,
    onServicesReady: (services) => {
      servicesReady = true
      app.on('browser-window-focus', () => services.githubPolling.refreshIfStale())
      powerMonitor.on('resume', () => services.githubPolling.refreshIfStale())

      isClosing = registerAppShutdown(app, {
        showClosing: showClosingProcesses,
        cleanup: [
          () => services.stopCaffeineMode(),
          () => services.agentProcesses.close(),
          () => services.closeAgentDiscovery(),
          () => services.githubPolling.close(),
          () => services.projectMemory?.close()
        ],
        finalize: () => services.closeStore(),
        reportError: (error) => console.error('Could not complete app cleanup:', error)
      })

      process.on('SIGINT', () => app.quit())
      process.on('SIGTERM', () => app.quit())

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
    },
    onInitFailed: (error) => {
      console.error('Could not initialize Anvil services:', error)
      dialog.showErrorBox('Anvil failed to start', error instanceof Error ? error.message : String(error))
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
