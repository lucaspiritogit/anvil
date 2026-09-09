import { expect, test } from '@playwright/test'

const fixture = '/tests/e2e/fixture/?wallpapers&appearance'

test('saved image stays inside overview across project switches, task views and resizing', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/')
  const sidebar = page.locator('aside').first()
  const baseline = await sidebar.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).backgroundImage])
  await page.getByRole('button', { name: 'Open task: Layout test task', exact: true }).click()
  const output = page.getByRole('complementary', { name: 'Prompt and output' })
  const taskBackground = await output.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).backgroundImage])
  await page.keyboard.press('Control+t')
  const terminalBackground = await page.locator('.xterm-viewport').evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).backgroundImage])
  await page.goto(fixture)
  const overview = page.getByTestId('project-overview')
  const layer = page.getByTestId('overview-wallpaper')
  await expect(layer).toHaveAttribute('data-src', /data:image/)
  expect(await layer.evaluate((el) => (el as HTMLCanvasElement).width > 0 && (el as HTMLCanvasElement).height > 0)).toBe(true)
  expect(await sidebar.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).backgroundImage])).toEqual(baseline)
  await page.getByRole('combobox', { name: 'Project', exact: true }).click()
  await page.getByRole('option').filter({ hasText: '/tmp/workbench' }).click()
  await expect(layer).toHaveAttribute('data-src', /data:image/)
  await page.setViewportSize({ width: 900, height: 600 })
  await page.getByRole('button', { name: 'Send', exact: true }).scrollIntoViewIfNeeded()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport()
  await page.screenshot({ path: testInfo.outputPath('overview-wallpaper-sidebar.png') })
  await page.getByRole('button', { name: 'Open task: Layout test task', exact: true }).click()
  await expect(overview).toHaveCount(0)
  await expect(page.getByRole('main')).toHaveCSS('background-image', 'none')
  expect(await output.evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).backgroundImage])).toEqual(taskBackground)
  await page.keyboard.press('Control+t')
  expect(await page.locator('.xterm-viewport').evaluate((el) => [getComputedStyle(el).backgroundColor, getComputedStyle(el).backgroundImage])).toEqual(terminalBackground)
})

test('delayed settings and missing files use the saved color', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?appearance&settingsLoading')
  await expect(page.getByText('Loading settings…')).toBeVisible()
  await page.evaluate(() => window.settingsTest.finishLoading())
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  const overview = page.getByTestId('project-overview')
  await expect(overview).toHaveCSS('background-color', 'rgb(18, 52, 86)')
  await expect(page.getByTestId('overview-wallpaper')).toHaveCount(0)
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toBeEditable()
})

test('obsolete reads cannot replace a newer image or color, and decode failures fall back', async ({ page }) => {
  await page.goto(fixture)
  const overview = page.getByTestId('project-overview')
  const layer = page.getByTestId('overview-wallpaper')
  await expect(layer).toHaveAttribute('data-src', /data:image/)
  await page.evaluate(async () => {
    const valid = await window.anvil.wallpapers.read('image-0.png')
    window.anvil.wallpapers.read = () => new Promise((resolve) => {
      window.settingsTest.release = () => resolve(valid)
    })
    window.settingsTest.apply({ overviewWallpaperId: 'image-1.png' })
  })
  await expect(layer).toHaveCount(0)
  await page.evaluate(async () => {
    const valid = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='
    window.anvil.wallpapers.read = async () => `${valid}#new-selection`
    window.settingsTest.apply({ overviewWallpaperId: 'image-2.png' })
  })
  await expect(layer).toHaveAttribute('data-src', /new-selection/)
  await page.evaluate(() => window.settingsTest.release())
  await expect(layer).toHaveAttribute('data-src', /new-selection/)
  await page.evaluate(() => {
    window.settingsTest.apply({ overviewBackgroundMode: 'color', overviewBackgroundColor: '#abcdef' })
  })
  await expect(overview).toHaveCSS('background-color', 'rgb(171, 205, 239)')
  await page.evaluate(() => window.settingsTest.release())
  await expect(layer).toHaveCount(0)
  await page.evaluate(() => {
    window.anvil.wallpapers.read = async () => 'data:image/png;base64,broken'
    window.settingsTest.apply({ overviewBackgroundMode: 'image', overviewWallpaperId: 'broken-image.png' })
  })
  await expect(layer).toHaveCount(0)
  await expect(overview).toHaveCSS('background-color', 'rgb(171, 205, 239)')
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toBeEditable()
})

test('a rejected image read preserves the fallback and composer', async ({ page }) => {
  await page.goto(fixture)
  await expect(page.getByTestId('overview-wallpaper')).toHaveAttribute('data-src', /data:image/)
  await page.evaluate(() => {
    window.anvil.wallpapers.read = async () => { throw new Error('Unreadable') }
    window.settingsTest.apply({ overviewWallpaperId: 'unreadable.png' })
  })
  await expect(page.getByTestId('overview-wallpaper')).toHaveCount(0)
  await expect(page.getByTestId('project-overview')).toHaveCSS('background-color', 'rgb(18, 52, 86)')
  await page.getByRole('textbox', { name: 'Task prompt' }).fill('Keep composing')
})
