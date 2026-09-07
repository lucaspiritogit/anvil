import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { registerIpc } from './ipc'
import { registerAppShutdown } from './app-shutdown'
import { exposeValenceLauncher, installValenceLauncher } from './valence/launcher'

let mainWindow: BrowserWindow | null = null
let isClosing = (): boolean => false

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
  `)}`)
}

function createWindow(): void {
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
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('close', (event) => { if (isClosing()) event.preventDefault() })
  mainWindow.on('closed', () => { mainWindow = null })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServer = process.env.ELECTRON_RENDERER_URL
  if (devServer) {
    mainWindow.loadURL(devServer)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
}

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.whenReady().then(() => {
  const cliDirectory = join(app.getPath('userData'), 'bin')
  installValenceLauncher(cliDirectory, process.execPath, join(__dirname, 'valence-cli.js'))
  exposeValenceLauncher(cliDirectory)
  const services = registerIpc(() => mainWindow)

  isClosing = registerAppShutdown(app, {
    showClosing: showClosingProcesses,
    cleanup: async () => {
      services.terminals.disposeAll()
      await Promise.all([
        services.agentProcesses.close(),
        services.projectMemory?.close().catch((error) => console.warn('Could not close project memory:', error))
      ])
    },
    reportError: (error) => console.error('Could not close agent processes:', error)
  })

  createWindow()

  app.on('activate', () => {
    if (!isClosing() && BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
