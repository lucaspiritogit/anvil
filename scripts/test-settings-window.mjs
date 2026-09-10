import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect } from '@playwright/test'

// Run after npm run build. All mutations use an isolated application profile.
// --manual leaves the tested window open until Enter for native UI inspection.
const directory = await mkdtemp(join(tmpdir(), 'anvil-settings-main-'))
const screenshots = resolve('test-results/settings-electron')
await mkdir(screenshots, { recursive: true })
const env = {
  ...process.env, HOME: directory, CFFIXED_USER_HOME: directory, USERPROFILE: directory,
  XDG_CONFIG_HOME: join(directory, '.config'), ANVIL_DATA_DIR: directory,
  ANVIL_MEMORY_BACKEND: 'disabled', SHELL: '/bin/bash'
}
delete env.ELECTRON_RUN_AS_NODE
delete env.ELECTRON_RENDERER_URL
let executablePath
if (process.argv.includes('--manual') && process.platform === 'darwin') {
  const bundle = join(directory, 'Settings Verification.app')
  await cp(resolve('node_modules/electron/dist/Electron.app'), bundle, { recursive: true, verbatimSymlinks: true })
  executablePath = join(bundle, 'Contents/MacOS/Electron')
  console.log(`Inspection app: ${bundle}`)
}
let application
try {
  application = await electron.launch({ executablePath, args: ['.'], env })
  assert.equal(await application.evaluate(({ app }) => app.getPath('home')), directory)
  application.context().setDefaultTimeout(15000)
  const main = await application.firstWindow()
  const mainId = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id)
  const onlyMainWindow = async () => {
    assert.deepEqual(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.id)), [mainId])
  }
  const nativeMenu = async () => {
    await application.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu().items.flatMap((item) => item.submenu?.items ?? []).find((item) => item.label === 'Settings…')
      if (item?.accelerator !== 'CommandOrControl+,') throw new Error('Missing settings menu accelerator')
      item.click()
    })
  }
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] })
  }, directory)
  await main.getByRole('button', { name: 'Choose folder', exact: true }).click()
  const prompt = main.getByRole('textbox', { name: 'Task prompt' })
  await prompt.fill('Keep this draft while changing settings')
  await main.getByRole('button', { name: 'Settings', exact: true }).click()
  const navigation = main.getByRole('navigation', { name: 'Settings sections' })
  await expect(navigation).toBeVisible()
  await expect(navigation.locator('svg[aria-hidden="true"]')).toHaveCount(6)
  await expect(prompt).toBeHidden()
  await onlyMainWindow()
  await nativeMenu()
  await onlyMainWindow()
  const navigate = (name) => navigation.getByRole('button', { name, exact: true }).click()
  await navigate('Display')
  await main.getByLabel('Font size', { exact: true }).selectOption('16')
  await main.getByLabel('Background color', { exact: true }).fill('#123456')
  await expect(main.getByText('Saved', { exact: true })).toBeVisible()
  await expect.poll(() => main.locator('#root').evaluate((element) => Number(element.style.zoom))).toBeCloseTo(16 / 14)
  await expect(main.getByTestId('settings-page').getByRole('button', { name: /^(Save|Close)$/ })).toHaveCount(0)
  await main.screenshot({ path: join(screenshots, 'display.png') })
  await navigate('Keyboard shortcuts')
  const shortcut = main.getByRole('button', { name: process.platform === 'darwin' ? '⌘B' : 'Ctrl+B', exact: true })
  await shortcut.click()
  await main.keyboard.press('Escape')
  await expect(navigation).toBeVisible()
  await navigate('General')
  await main.getByLabel('Monthly token limit', { exact: true }).fill('123')
  await expect(main.getByText('Saved', { exact: true })).toBeVisible()
  await main.screenshot({ path: join(screenshots, 'general.png') })
  await navigate('Memory')
  await main.getByRole('checkbox', { name: /Enable project memory/ }).check()
  await expect(main.getByText('Saved', { exact: true })).toBeVisible()
  assert.equal(await main.evaluate(async () => (await window.anvil.settings.get()).memoryEnabled), true)
  await main.getByRole('checkbox', { name: /Enable project memory/ }).uncheck()
  await expect(main.getByText('Saved', { exact: true })).toBeVisible()
  await main.keyboard.press('Escape')
  await expect(prompt).toBeVisible()
  await expect(prompt).toHaveValue('Keep this draft while changing settings')
  await expect(main.getByTestId('overview-background')).toHaveCSS('background-color', 'rgb(18, 52, 86)')
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
  await main.keyboard.press(`${mod}+b`)
  await main.keyboard.press(`${mod}+,`)
  await expect(navigation).toBeVisible()
  await expect(main.getByLabel('Monthly token limit', { exact: true })).toHaveValue('123')
  await onlyMainWindow()
  await main.getByRole('button', { name: 'Back to workspace' }).click()
  await expect(main.getByRole('complementary', { name: 'Task sidebar', includeHidden: true })).toHaveAttribute('inert', '')
  await expect(prompt).toHaveValue('Keep this draft while changing settings')
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize())
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true)
  await nativeMenu()
  await expect(navigation).toBeVisible()
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    return !window.isMinimized() && window.isVisible() && window.isFocused()
  })).toBe(true)
  await onlyMainWindow()
  await navigate('Display')
  await expect(main.getByLabel('Font size', { exact: true })).toHaveValue('16')
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 600))
  console.log('Native layout dimensions:', await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize()), await main.evaluate(() => ({ width: innerWidth, height: innerHeight })))
  await main.getByLabel('Font size', { exact: true }).selectOption('18')
  await expect(main.getByText('Saved', { exact: true })).toBeVisible()
  for (const section of ['General', 'Providers', 'Source control', 'Keyboard shortcuts', 'Memory', 'Display']) {
    await navigate(section)
    await expect(main.getByRole('heading', { name: section, exact: true })).toBeInViewport()
    await expect(main.getByText('Saved', { exact: true })).toBeInViewport()
    assert.equal(await main.getByTestId('settings-page').evaluate((element) => element.scrollWidth <= element.clientWidth), true)
    await main.screenshot({ path: join(screenshots, `small-${section.toLowerCase().replaceAll(' ', '-')}.png`) })
    const content = main.getByTestId('settings-page').locator('main')
    await content.evaluate((element) => { element.scrollTop = element.scrollHeight })
    await main.screenshot({ path: join(screenshots, `small-${section.toLowerCase().replaceAll(' ', '-')}-bottom.png`) })
    await content.evaluate((element) => { element.scrollTop = 0 })
  }
  assert.equal(await main.getByTestId('settings-page').evaluate((element) => element.scrollWidth <= element.clientWidth), true)
  await main.screenshot({ path: join(screenshots, 'small.png') })
  if (process.platform === 'darwin' && !process.argv.includes('--manual')) {
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    await expect.poll(() => application.windows().length).toBe(0)
    const opened = application.waitForEvent('window')
    await nativeMenu()
    const restored = await opened
    await expect(restored.getByRole('navigation', { name: 'Settings sections' })).toBeVisible({ timeout: 15000 })
    await expect(restored.getByLabel('Monthly token limit', { exact: true })).toHaveValue('123')
    assert.equal(application.windows().length, 1)
    assert.equal(new URL(restored.url()).hash, '')
  }
  console.log('Electron settings passed: sidebar, native menu, keyboard, one window, restore/focus, autosave/Escape/reopen, collapsed sidebar restored, composer draft retained, display/project/memory preferences, shortcut recording, all six sections at small-window layout with enlarged font.')
  if (process.argv.includes('--manual')) {
    console.log(`Manual inspection ready. Profile: ${directory}. Press Enter to finish.`)
    process.stdin.resume()
    await new Promise((resolve) => process.stdin.once('data', resolve))
    process.stdin.pause()
  }
} finally {
  await application?.close()
  await rm(directory, { recursive: true, force: true })
}
