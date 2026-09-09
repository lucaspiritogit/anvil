import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect } from 'playwright/test'

// Run after npm run build. Uses the built renderer, real preload/IPC and SQLite.
// Requires sqlite3 on PATH. --inspect leaves an isolated window for manual checks.
const directory = await mkdtemp(join(tmpdir(), 'anvil-caffeine-check-'))
const database = join(directory, '.anvil-composer', 'anvil.db')
const artifacts = resolve('docs/validation/caffeine-persistence')
const query = "SELECT key, value, typeof(value) AS storageType FROM settings WHERE key = 'caffeineMode'"
const executablePath = process.argv.find((arg) => arg.startsWith('--executable='))?.slice('--executable='.length)
const env = {
  ...process.env, HOME: directory, CFFIXED_USER_HOME: directory, USERPROFILE: directory,
  ANVIL_DATA_DIR: join(directory, '.anvil-composer'), ANVIL_MEMORY_BACKEND: 'disabled', SHELL: '/bin/bash'
}
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let application

function rows() {
  return JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', database, query], { encoding: 'utf8' }))
}

async function launch() {
  application = await electron.launch({
    executablePath,
    args: ['--use-mock-keychain', '--password-store=basic', '.', `--user-data-dir=${join(directory, 'user-data')}`], env
  })
  const page = await application.firstWindow()
  await page.waitForFunction(() => Boolean(window.anvil))
  assert.equal(await application.evaluate(({ app }) => app.getPath('home')), directory)
  assert.ok(page.url().startsWith('file://'))
  // Test-only fault injection. Successful calls delegate to the real registered
  // handler, preserving validation and Store writes. No renderer API is mocked.
  await application.evaluate(({ ipcMain }) => {
    const handler = ipcMain._invokeHandlers.get('settings:set')
    if (!handler) throw new Error('settings:set handler missing')
    globalThis.caffeineTest = { calls: [], controlled: false, release: null, delay: 0, rejectNext: false }
    ipcMain.removeHandler('settings:set')
    ipcMain.handle('settings:set', async (event, patch) => {
      const control = globalThis.caffeineTest
      control.calls.push(patch)
      if (control.controlled) {
        await new Promise((resolve, reject) => {
          if (control.release) throw new Error('Overlapping settings writes')
          control.release = (fail) => {
            control.release = null
            if (fail) reject(new Error('Injected settings write failure'))
            else resolve()
          }
        })
      }
      if (control.delay) await new Promise((resolve) => setTimeout(resolve, control.delay))
      if (control.rejectNext) {
        control.rejectNext = false
        throw new Error('Injected settings write failure')
      }
      return handler(event, patch)
    })
  })
  await openSettings(page)
  return page
}

async function openSettings(page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
}

function toggle(page) {
  return page.getByRole('checkbox', { name: /Caffeine mode/ })
}

async function verify(page, stage, value) {
  await expect(toggle(page)).toBeChecked({ checked: value })
  await expect(page.getByText('Caffeine mode saves automatically.', { exact: true })).toBeVisible()
  await expect.poll(rows).toEqual([{ key: 'caffeineMode', value: String(value), storageType: 'text' }])
  assert.equal(await page.evaluate(async () => (await window.anvil.settings.get()).caffeineMode), value)
  console.log(JSON.stringify({ stage, rows: rows(), checked: value }))
}

async function release(fail = false) {
  await expect.poll(() => application.evaluate(() => Boolean(globalThis.caffeineTest.release))).toBe(true)
  await application.evaluate((_, reject) => globalThis.caffeineTest.release(reject), fail)
}

async function calls() {
  return application.evaluate(() => globalThis.caffeineTest.calls)
}

try {
  await mkdir(artifacts, { recursive: true })
  console.log(JSON.stringify({ database, query, renderer: 'built file:// renderer' }))
  let page = await launch()
  await verify(page, 'default', false)
  await toggle(page).check()
  await verify(page, 'enabled without Save', true)
  assert.deepEqual(await calls(), [{ caffeineMode: true }])
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await openSettings(page)
  await verify(page, 'enabled after Close and reopen', true)
  await application.close()
  page = await launch()
  await verify(page, 'enabled after relaunch', true)
  await toggle(page).uncheck()
  await verify(page, 'disabled without Save', false)
  assert.deepEqual(await calls(), [{ caffeineMode: false }])
  await application.close()
  page = await launch()
  await verify(page, 'disabled after relaunch', false)

  await application.evaluate(() => { globalThis.caffeineTest.controlled = true })
  for (const dismissal of ['Close', 'Escape', 'backdrop']) {
    await toggle(page).check()
    await expect(page.getByText('Saving Caffeine mode…', { exact: true })).toBeVisible()
    assert.equal(rows()[0].value, 'false')
    if (dismissal === 'Close') {
      await page.screenshot({ path: join(artifacts, 'pending.png') })
      await page.getByRole('button', { name: 'Close', exact: true }).click()
    } else if (dismissal === 'Escape') await page.keyboard.press('Escape')
    else await page.mouse.click(5, 40)
    await expect(toggle(page)).not.toBeVisible()
    await release()
    await openSettings(page)
    await verify(page, `pending write completed after ${dismissal}`, true)
    await toggle(page).uncheck()
    await release()
    await verify(page, `reset after ${dismissal}`, false)
  }

  await toggle(page).check()
  await release(true)
  await expect(page.getByRole('alert')).toContainText('Could not save Caffeine mode')
  await expect(toggle(page)).not.toBeChecked()
  assert.equal(rows()[0].value, 'false')
  await page.screenshot({ path: join(artifacts, 'error.png') })
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await openSettings(page)
  await expect(page.getByRole('alert')).toBeVisible()
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await release()
  await verify(page, 'retry enabled', true)

  await application.evaluate(() => { globalThis.caffeineTest.calls = [] })
  await toggle(page).uncheck()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await toggle(page).check()
  await toggle(page).uncheck()
  assert.deepEqual(await calls(), [{ caffeineMode: false }])
  for (let count = 1; count <= 4; count += 1) {
    await expect.poll(async () => (await calls()).length).toBe(count)
    await expect(toggle(page)).not.toBeChecked()
    await release()
  }
  await verify(page, 'rapid toggle and stale Save finish disabled', false)
  const patches = await calls()
  assert.equal(Object.hasOwn(patches[1], 'caffeineMode'), false)
  assert.deepEqual(patches.filter((patch) => Object.hasOwn(patch, 'caffeineMode')),
    [{ caffeineMode: false }, { caffeineMode: true }, { caffeineMode: false }])
  console.log(JSON.stringify({ stage: 'rapid toggle and Save IPC patches', patches }))
  await page.screenshot({ path: join(artifacts, 'saved.png') })
  await application.close()
  page = await launch()
  await verify(page, 'latest rapid choice after relaunch', false)
  console.log('PASS: checkbox to SQLite, both restart directions, pending dismissal, rejection/retry and rapid toggle/Save')

  if (process.argv.includes('--inspect')) {
    await application.evaluate(() => {
      globalThis.caffeineTest.delay = 2500
      globalThis.caffeineTest.rejectNext = true
    })
    console.log(`Manual check window PID ${application.process().pid}; database ${database}`)
    console.log('First toggle will fail after 2.5 seconds. Retry will save after 2.5 seconds. Press Enter after inspection.')
    process.stdin.resume()
    await once(process.stdin, 'data')
    process.stdin.pause()
    console.log(JSON.stringify({ stage: 'after manual UI inspection', rows: rows(), patches: await calls() }))
  }
} finally {
  await application?.close()
  await rm(directory, { recursive: true, force: true })
}
