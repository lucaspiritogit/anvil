import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'
import { loadConfigFromFile } from 'electron-vite'
import { createServer } from 'vite'

// Run after npm run build. Requires sqlite3 on PATH. This diagnostic records
// behavior; the expected-red assertions live in tests/e2e/caffeine-mode.spec.ts.
const directory = await mkdtemp(join(tmpdir(), 'anvil-caffeine-persistence-'))
const database = join(directory, '.anvil-composer', 'anvil.db')
const query = "SELECT key, value FROM settings WHERE key = 'caffeineMode'"
let server
let application

try {
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' })
  server = await createServer({ ...loaded.config.renderer, configFile: false, server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  const env = {
    ...process.env, HOME: directory, CFFIXED_USER_HOME: directory, USERPROFILE: directory,
    ANVIL_DATA_DIR: join(directory, '.anvil-composer'), ANVIL_MEMORY_BACKEND: 'disabled', SHELL: '/bin/bash', ELECTRON_RENDERER_URL: server.resolvedUrls.local[0]
  }
  delete env.ELECTRON_RUN_AS_NODE

  async function launch() {
    application = await electron.launch({
      args: ['--use-mock-keychain', '--password-store=basic', '.', `--user-data-dir=${join(directory, 'user-data')}`], env
    })
    const page = await application.firstWindow()
    await page.waitForFunction(() => Boolean(window.anvil))
    assert.equal(await application.evaluate(({ app }) => app.getPath('home')), directory)
    // Electron has no public API for observing invoke payloads. This test-only
    // hook delegates to the existing handler, including its sender validation.
    await application.evaluate(({ ipcMain }) => {
      const handler = ipcMain._invokeHandlers.get('settings:set')
      if (!handler) throw new Error('Cannot observe settings:set: handler missing')
      globalThis.caffeineSettingsCalls = []
      ipcMain.removeHandler('settings:set')
      ipcMain.handle('settings:set', (event, patch) => {
        globalThis.caffeineSettingsCalls.push(patch)
        return handler(event, patch)
      })
    })
    return page
  }

  async function snapshot(page, stage) {
    const rows = JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', database, query], { encoding: 'utf8' }) || '[]')
    const types = JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', database,
      "SELECT typeof(value) AS storageType FROM settings WHERE key = 'caffeineMode'"], { encoding: 'utf8' }) || '[]')
    const calls = await application.evaluate(() => globalThis.caffeineSettingsCalls)
    const caffeineMode = await page.evaluate(async () => (await window.anvil.settings.get()).caffeineMode)
    const toggle = page.getByRole('checkbox', { name: /Caffeine mode/ })
    const checked = await toggle.isVisible() ? await toggle.isChecked() : null
    console.log(JSON.stringify({ stage, rows, types, caffeineMode, checked, settingsSetCalls: calls }))
    return { rows, caffeineMode, checked }
  }

  console.log(JSON.stringify({ database, query }))
  let page = await launch()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  assert.equal((await snapshot(page, 'default')).caffeineMode, false)

  for (const dismissal of ['Close', 'Escape', 'backdrop']) {
    await page.getByRole('checkbox', { name: /Caffeine mode/ }).check()
    await snapshot(page, `enabled before ${dismissal}`)
    if (dismissal === 'Close') {
      await page.getByRole('button', { name: 'Close', exact: true }).click()
    } else if (dismissal === 'Escape') {
      await page.keyboard.press('Escape')
    } else {
      await page.mouse.click(5, 40)
    }
    await page.getByRole('checkbox', { name: /Caffeine mode/ }).waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await snapshot(page, `reopened after ${dismissal}`)
  }

  await application.close()
  page = await launch()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await snapshot(page, 'restart without Save')
  await page.getByRole('checkbox', { name: /Caffeine mode/ }).check()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByText('Saved', { exact: true }).waitFor()
  const saved = await snapshot(page, 'explicit Save enabled')
  assert.deepEqual(saved.rows, [{ key: 'caffeineMode', value: 'true' }])
  assert.equal(saved.caffeineMode, true)

  await application.close()
  page = await launch()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const restarted = await snapshot(page, 'restart after Save')
  assert.equal(restarted.caffeineMode, true)
  assert.equal(restarted.checked, true)
  await page.getByRole('checkbox', { name: /Caffeine mode/ }).uncheck()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await page.getByText('Saved', { exact: true }).waitFor()
  const disabled = await snapshot(page, 'explicit Save disabled')
  assert.deepEqual(disabled.rows, [{ key: 'caffeineMode', value: 'false' }])
  assert.equal(disabled.caffeineMode, false)
} finally {
  await application?.close()
  await server?.close()
  await rm(directory, { recursive: true, force: true })
}
