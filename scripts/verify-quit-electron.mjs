// Run after npm run build. Uses a disposable macOS profile and only kills test-owned PIDs.
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

if (process.platform !== 'darwin') throw new Error('This check requires macOS')
const executablePath = process.argv[2]
const directory = await mkdtemp(join(tmpdir(), 'anvil-quit-'))
const pids = new Set()
let application
const alive = (pid) => {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}
try {
  for (const mode of ['idle', 'renderer-veto', 'no-windows', 'sigterm']) {
    const home = join(directory, mode)
    await mkdir(home)
    const env = { ...process.env, HOME: home, CFFIXED_USER_HOME: home, ANVIL_DATA_DIR: join(home, 'data'), ANVIL_MEMORY_BACKEND: 'disabled', SHELL: '/bin/bash' }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    application = await electron.launch({ executablePath, args: executablePath ? [] : ['.'], cwd: resolve('.'), env, timeout: 30_000 })
    const child = application.process()
    pids.add(child.pid)
    const page = await application.firstWindow()
    await page.waitForFunction(() => !!window.anvil)
    expect(await application.evaluate(({ app }) => app.getPath('home'))).toBe(home)
    const quitRole = await application.evaluate(({ Menu }) => {
      const find = (menu) => menu.items.flatMap((item) => [item, ...(item.submenu ? find(item.submenu) : [])])
      return find(Menu.getApplicationMenu()).some((item) => item.role === 'quit')
    })
    expect(quitRole).toBe(true)
    if (mode === 'renderer-veto') {
      await page.evaluate(() => { window.onbeforeunload = () => false })
      await application.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.on('close', (event) => event.preventDefault())
      })
    }
    if (mode === 'no-windows') await application.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.destroy()
    })
    for (const pid of await application.evaluate(({ app }) => app.getAppMetrics().map((metric) => metric.pid))) pids.add(pid)
    const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
    const start = Date.now()
    if (mode === 'sigterm') child.kill('SIGTERM')
    else if (mode === 'no-windows') await application.evaluate(({ app }) => { setImmediate(() => app.quit()) })
    else {
      // Invoke the native macOS Quit action used by the menu's Cmd+Q accelerator.
      await application.evaluate(({ Menu }) => { setImmediate(() => Menu.sendActionToFirstResponder('terminate:')) })
    }
    let timer
    const result = await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${mode}: app did not exit`)), 12_000) })]).finally(() => clearTimeout(timer))
    expect(result.code).toBe(0)
    for (const pid of pids) await expect.poll(() => alive(pid), { timeout: 3_000 }).toBe(false)
    console.log(`${mode}: exited in ${Date.now() - start} ms; Electron PIDs are gone`)
    application = undefined
  }
} finally {
  for (const pid of pids) if (alive(pid)) { try { process.kill(pid, 'SIGKILL') } catch {} }
  if (application) await application.close().catch(() => {})
  await delay(100)
  await rm(directory, { recursive: true, force: true })
}
