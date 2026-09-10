import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import sharp from 'sharp'

const fixture = '/tests/e2e/fixture/?wallpapers&appearance'

async function wideWallpaper(): Promise<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0b3d91"/><stop offset="1" stop-color="#e63946"/>
    </linearGradient></defs>
    <rect width="1200" height="800" fill="url(#g)"/>
    <circle cx="600" cy="400" r="320" fill="none" stroke="#ffffff" stroke-width="10"/>
    <circle cx="600" cy="400" r="200" fill="none" stroke="#ffd166" stroke-width="10"/>
    <path d="M0 0 L1200 800 M1200 0 L0 800" stroke="#ffffff" stroke-width="5" opacity="0.6"/>
  </svg>`
  const png = await sharp(Buffer.from(svg)).png().toBuffer()
  return `data:image/png;base64,${png.toString('base64')}`
}

test('manual wallpaper/sidebar integration check', async ({ page }, testInfo) => {
  const wallpaper = await wideWallpaper()
  await page.addInitScript(() => {
    const counter = { draws: 0 }
    Object.assign(window, { __wallpaperDraws: counter })
    const original = CanvasRenderingContext2D.prototype.drawImage
    CanvasRenderingContext2D.prototype.drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
      if ((this.canvas as HTMLCanvasElement).dataset.testid === 'overview-wallpaper') counter.draws += 1
      return (original as (...inner: unknown[]) => unknown).apply(this, args)
    }
  })
  await page.goto(fixture)
  const canvas = page.getByTestId('overview-wallpaper')
  const background = page.getByTestId('overview-background')
  const composer = page.getByRole('form', { name: 'Start a task' })
  await expect(canvas).toHaveAttribute('data-src', /data:image/)
  await page.evaluate((url) => {
    window.anvil.wallpapers.read = async () => url
    window.settingsTest.apply({ overviewBackgroundMode: 'image', overviewWallpaperId: 'manual-wide.png' })
  }, wallpaper)
  await expect.poll(async () => (await canvas.getAttribute('data-src'))!.length).toBeGreaterThan(1000)

  const draws = (): Promise<number> => page.evaluate(() => (window as unknown as { __wallpaperDraws: { draws: number } }).__wallpaperDraws.draws)
  const resetDraws = (): Promise<void> => page.evaluate(() => { (window as unknown as { __wallpaperDraws: { draws: number } }).__wallpaperDraws.draws = 0 })
  const capture = async (): Promise<{ width: number; height: number; box: unknown; hash: string }> => {
    const width = await canvas.evaluate((element) => (element as HTMLCanvasElement).width)
    const height = await canvas.evaluate((element) => (element as HTMLCanvasElement).height)
    const box = await background.boundingBox()
    const dataUrl = await canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL())
    return { width, height, box, hash: createHash('sha256').update(dataUrl).digest('hex') }
  }

  for (const [width, height, label] of [[1280, 800, 'desktop'], [600, 700, 'narrow']] as const) {
    await page.setViewportSize({ width, height })
    await page.waitForTimeout(400)
    await resetDraws()
    const before = await capture()
    const expandedComposer = (await composer.boundingBox())!.width
    await page.screenshot({ path: testInfo.outputPath(`manual-${label}-open.png`) })
    await page.keyboard.press('Control+b')
    await expect.poll(async () => (await composer.boundingBox())!.width).toBeGreaterThan(expandedComposer)
    await page.waitForTimeout(250)
    expect(await capture()).toEqual(before)
    expect(await draws()).toBe(0)
    await page.screenshot({ path: testInfo.outputPath(`manual-${label}-collapsed.png`) })
    const collapsedComposer = (await composer.boundingBox())!.width
    await page.keyboard.press('Control+b')
    await expect.poll(async () => (await composer.boundingBox())!.width).toBeLessThan(collapsedComposer)
    await page.waitForTimeout(250)
    expect(await capture()).toEqual(before)
    expect(await draws()).toBe(0)
  }

  // Navigation sanity after all toggles: sidebar task, workspace selector, settings.
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.getByRole('button', { name: 'Open task: Layout test task', exact: true }).click()
  await expect(page.getByTestId('project-overview')).toHaveCount(0)
  await page.getByRole('button', { name: 'Back to workspace', exact: true }).click()
  await expect(page.getByTestId('project-overview')).toBeVisible()
  await page.getByRole('combobox', { name: 'Workspace', exact: true }).click()
  await expect(page.getByRole('listbox', { name: 'Workspaces' })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('complementary').getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('overview-background')).toBeVisible()
})
