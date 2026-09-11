// Run after npm run build. Pass the unsigned macOS executable to check the package.
import { _electron as electron, expect } from '@playwright/test'
import { mkdtemp, mkdir, unlink, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

if (process.platform !== 'darwin') throw new Error('This harness uses CFFIXED_USER_HOME to isolate macOS app data')
const executablePath = process.argv[2]
const mode = executablePath ? 'packaged' : 'development'
const home = await mkdtemp(join(tmpdir(), 'anvil-overview-'))
const project = join(home, 'Wallpaper verification')
await mkdir(project)
const output = resolve('test-results', `overview-electron-${mode}`)
await mkdir(output, { recursive: true })
const env = { ...process.env, HOME: home, CFFIXED_USER_HOME: home, ANVIL_DATA_DIR: join(home, 'app-data'), ANVIL_MEMORY_BACKEND: 'disabled', SHELL: '/bin/bash' }
delete env.ELECTRON_RUN_AS_NODE
let server
if (!executablePath) {
  server = await createServer({
    configFile: false, root: resolve('src/client/renderer'),
    resolve: { alias: { '@shared': resolve('src/shared'), '@renderer': resolve('src/client/renderer/src'), '@public': resolve('public') } },
    plugins: [react(), tailwindcss()], server: { host: '127.0.0.1', port: 0 }
  })
  await server.listen()
  env.ELECTRON_RENDERER_URL = server.resolvedUrls.local[0]
}
let app
let page
let settingsPage
const violations = []
async function launch() {
  app = await electron.launch({ executablePath, args: [`--user-data-dir=${join(home, 'userdata')}`, ...(executablePath ? [] : ['.'])], env })
  const actualHome = await app.evaluate(({ app }) => app.getPath('home'))
  expect(actualHome).toBe(home)
  page = await app.firstWindow()
  page.on('console', (message) => { if (/Content Security Policy|Refused to load/i.test(message.text())) violations.push(message.text()) })
  await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
}
async function settings() {
  const opened = app.waitForEvent('window')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  settingsPage = await opened
  await settingsPage.getByRole('button', { name: 'Display', exact: true }).click()
}
async function save() {
  await settingsPage.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(settingsPage.getByText('Saved', { exact: true })).toBeVisible()
  await settingsPage.getByRole('button', { name: 'Close', exact: true }).click()
}
try {
  await launch()
  await app.evaluate(({ dialog }, project) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] }) }, project)
  await page.getByRole('button', { name: 'Choose folder', exact: true }).click()
  const overview = () => page.getByTestId('project-overview')
  await expect(overview()).toBeVisible()
  const sidebar = () => page.locator('aside').first()
  const baseline = await sidebar().evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).backgroundImage])
  await settings()
  await expect(settingsPage.getByText('No supported images found.', { exact: false })).toBeVisible()
  const imagePath = join(env.ANVIL_DATA_DIR, 'wallpaper/test-wallpaper.png')
  await copyFile('tests/fixtures/images/sample.png', imagePath)
  await settingsPage.getByRole('button', { name: 'Refresh', exact: true }).click()
  await settingsPage.getByRole('radio', { name: 'Image', exact: true }).check()
  await settingsPage.getByRole('button', { name: 'test-wallpaper.png', exact: true }).click()
  await settingsPage.getByLabel('Background color', { exact: true }).fill('#345678')
  await settingsPage.screenshot({ path: join(output, 'carousel.png') })
  await save()
  await expect(overview()).toHaveCSS('background-image', /data:image\/png/)
  expect(await sidebar().evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).backgroundImage])).toEqual(baseline)
  await page.screenshot({ path: join(output, 'image.png') })
  await app.close()
  await launch()
  await expect(overview()).toHaveCSS('background-image', /data:image\/png/)
  await settings()
  await settingsPage.getByRole('radio', { name: 'Solid color', exact: true }).check()
  await save()
  await expect(overview()).toHaveCSS('background-image', 'none')
  await expect(overview()).toHaveCSS('background-color', 'rgb(52, 86, 120)')
  await app.close()
  await launch()
  await expect(overview()).toHaveCSS('background-color', 'rgb(52, 86, 120)')
  await expect(overview()).toHaveCSS('background-image', 'none')
  await settings()
  await settingsPage.getByRole('radio', { name: 'Image', exact: true }).check()
  await save()
  await expect(overview()).toHaveCSS('background-image', /data:image\/png/)
  await unlink(imagePath)
  await settings()
  await settingsPage.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(settingsPage.getByText(/Selected image test-wallpaper.png is unavailable/)).toBeVisible()
  await save()
  await expect(overview()).toHaveCSS('background-image', 'none')
  await expect(overview()).toHaveCSS('background-color', 'rgb(52, 86, 120)')
  await app.close()
  await launch()
  await expect(overview()).toHaveCSS('background-image', 'none')
  await expect(overview()).toHaveCSS('background-color', 'rgb(52, 86, 120)')
  await page.getByRole('textbox', { name: 'Task prompt' }).fill('Still editable after removing wallpaper')
  await page.screenshot({ path: join(output, 'missing-image.png') })
  expect(violations).toEqual([])
  console.log(`${mode}: folder creation, adding/refreshing images, image/color saves, restart persistence, removed-file fallback, editable composer, unchanged sidebar and CSP passed. Screenshots: ${output}. Isolated home: ${home}`)
} finally {
  if (app) await app.close()
  if (server) await server.close()
  await rm(home, { recursive: true, force: true })
}
