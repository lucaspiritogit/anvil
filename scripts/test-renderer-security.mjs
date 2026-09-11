import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { once } from 'node:events'
import { _electron as electron } from 'playwright'
import { loadConfigFromFile } from 'electron-vite'
import { createServer } from 'vite'

// Run after npm run build. Pass a packaged executable to check app.isPackaged,
// or omit it to serve the actual development renderer through Vite.
const executablePath = process.argv.find((arg, index) => index > 1 && !arg.startsWith('--'))
const directory = await mkdtemp(join(tmpdir(), 'anvil-renderer-security-'))
let server
let application
try {
  if (!executablePath) {
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' })
    server = await createServer({ ...loaded.config.renderer, configFile: false, server: { host: '127.0.0.1', port: 0 } })
    await server.listen()
  }
  const env = { ...process.env, HOME: directory, CFFIXED_USER_HOME: directory, USERPROFILE: directory, ANVIL_DATA_DIR: join(directory, '.anvil-composer'), ANVIL_MEMORY_BACKEND: 'disabled', SHELL: '/bin/bash' }
  delete env.ELECTRON_RUN_AS_NODE
  env.ELECTRON_RENDERER_URL = server ? server.resolvedUrls.local[0] : 'http://127.0.0.1:1/untrusted-env'
  application = await electron.launch({
    ...(executablePath ? { executablePath: resolve(executablePath) } : {}),
    args: ['--use-mock-keychain', '--password-store=basic', ...(executablePath ? [] : ['.']), `--user-data-dir=${join(directory, 'user-data')}`], env
  })
  const page = await application.firstWindow()
  await page.waitForFunction(() => Boolean(window.anvil))
  const state = await application.evaluate(({ app, BrowserWindow }) => ({
    packaged: app.isPackaged, home: app.getPath('home'),
    preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
  }))
  assert.equal(state.home, directory)
  assert.equal(state.packaged, Boolean(executablePath))
  assert.equal(state.preferences.sandbox, true)
  assert.equal(state.preferences.contextIsolation, true)
  assert.equal(state.preferences.nodeIntegration, false)
  assert.ok(page.url().startsWith(executablePath ? 'file://' : server.resolvedUrls.local[0]))
  assert.ok(await page.evaluate(() => window.anvil.settings.get()))
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
  console.log('Sandbox, preload and settings IPC passed:', page.url())

  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, directory)
  const project = await page.evaluate(() => window.anvil.projects.add())
  const projectId = project.id
  await page.reload()
  assert.match(await page.evaluate(() => window.anvil.projects.openTerminal('missing').then(() => 'unexpected success', (error) => error.message)), /Project not found/)
  const originalUrl = page.url()
  await page.evaluate(() => { location.href = 'https://example.com/forbidden' })
  await page.waitForTimeout(200)
  assert.equal(page.url(), originalUrl)
  const foreignPromise = application.waitForEvent('window')
  await application.evaluate(async ({ app, BrowserWindow }) => {
    const main = BrowserWindow.getAllWindows()[0]
    const foreign = new BrowserWindow({ show: false, webPreferences: { preload: `${app.getAppPath()}/out/preload/index.js`, sandbox: true, contextIsolation: true, nodeIntegration: false } })
    await foreign.loadURL(main.webContents.getURL())
  })
  const foreign = await foreignPromise
  await foreign.waitForFunction(() => Boolean(window.anvil))
  assert.match(await foreign.evaluate(() => window.anvil.settings.get().then(() => 'unexpected success', (error) => error.message)), /Unauthorized IPC sender/)
  assert.match(await foreign.evaluate((projectId) => window.anvil.projects.openTerminal(projectId).then(() => 'unexpected success', (error) => error.message), projectId), /Unauthorized IPC sender/)
  await foreign.close()
  console.log('Navigation and real foreign-window IPC rejection passed')

  // Observe the OS opener boundary without opening a browser during automated runs.
  await application.evaluate(({ shell }) => {
    globalThis.securityOpened = []
    globalThis.securityOriginalOpenExternal = shell.openExternal
    shell.openExternal = async (url) => { globalThis.securityOpened.push(url) }
  })
  const prUrl = 'https://github.com/openai/codex/pull/1'
  await page.evaluate(async (url) => {
    window.open('file:///tmp/forbidden')
    window.open('javascript:alert(1)')
    window.open(url)
    await window.anvil.github.openUrl(url)
  }, prUrl)
  await page.waitForTimeout(100)
  assert.deepEqual(await application.evaluate(() => globalThis.securityOpened), [prUrl, prUrl])
  assert.equal(application.windows().length, 1)
  await application.evaluate(({ shell }) => { shell.openExternal = async () => { throw new Error('fixture opener failure') } })
  assert.match(await page.evaluate((url) => window.anvil.github.openUrl(url).then(() => 'unexpected success', (error) => error.message), prUrl), /Could not open the GitHub PR/)
  await page.evaluate((url) => window.open(url), prUrl)
  assert.ok(await page.evaluate(() => window.anvil.settings.get()))
  await application.evaluate(({ shell }) => { shell.openExternal = globalThis.securityOriginalOpenExternal })
  console.log('Popup allowlist, GitHub PR IPC, and opener failure handling passed')
  if (process.argv.includes('--inspect')) {
    await page.evaluate((url) => {
      const panel = document.createElement('aside')
      panel.style.cssText = 'position:fixed;top:60px;right:30px;padding:20px;background:#20252c;color:white;z-index:9999'
      const output = document.createElement('pre')
      output.textContent = 'Security fixture: sandbox, preload and IPC checks passed'
      const button = document.createElement('button')
      button.id = 'open-pr-fixture'
      button.textContent = 'Open GitHub PR fixture'
      button.onclick = async () => {
        await window.anvil.github.openUrl(url)
        button.textContent = 'GitHub PR handed to browser'
      }
      panel.append(output, button)
      document.body.append(panel)
    }, prUrl)
    if (process.argv.includes('--open-pr')) {
      await page.evaluate(() => document.getElementById('open-pr-fixture').click())
      await page.waitForFunction(() => document.getElementById('open-pr-fixture').textContent === 'GitHub PR handed to browser')
      console.log('Real OS browser handoff passed')
    }
    console.log(`Inspect window now. PID ${application.process().pid}. Press Enter to finish.`)
    process.stdin.resume()
    await once(process.stdin, 'data')
    process.stdin.pause()
  }
} finally {
  await application?.close()
  await server?.close()
  await rm(directory, { recursive: true, force: true })
}
