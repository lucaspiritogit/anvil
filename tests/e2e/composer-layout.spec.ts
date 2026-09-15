import { expect, test } from '@playwright/test'
import { chooseProvider, restoreComposerSelection } from './composer-setup'

test.beforeEach(async ({ page }) => restoreComposerSelection(page))

const longModel = 'nvidia/nemotron-3-ultra-550b-a55b:free'

test('compact composer keeps the model and Send aligned, with other controls behind More', async ({ page }, testInfo) => {
  await page.goto(`/tests/e2e/fixture/?composerModel=${encodeURIComponent(longModel)}`)
  const composer = page.getByRole('form', { name: 'Start a task' })
  await chooseProvider(composer.getByRole('button', { name: /^(Choose a model|Model:)/ }), 'opencode', longModel)
  await composer.getByRole('textbox').fill('Keep this draft')

  for (const width of [900, 700, 600]) {
    await page.setViewportSize({ width, height: 600 })
    const more = composer.getByRole('button', { name: 'More task options', exact: true })
    await expect(more).toBeVisible()
    await expect(composer.getByRole('button', { name: 'Agent', exact: true })).toHaveCount(0)
    await expect(composer.getByRole('combobox', { name: 'Reasoning effort', exact: true })).toBeHidden()
    const model = composer.locator('button[aria-label^="Model: Nemotron"]')
    const send = composer.getByRole('button', { name: 'Send', exact: true })
    await expect(send).toBeInViewport()
    const modelBounds = await model.boundingBox()
    const sendBounds = await send.boundingBox()
    expect(modelBounds).not.toBeNull()
    expect(sendBounds).not.toBeNull()
    expect(Math.abs(modelBounds!.y + modelBounds!.height / 2 - sendBounds!.y - sendBounds!.height / 2)).toBeLessThan(2)
    expect(await composer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    await more.click()
    const options = page.getByRole('group', { name: 'Task options', exact: true })
    await expect(options).toBeInViewport()
    await options.getByRole('combobox', { name: 'Reasoning effort', exact: true }).selectOption('medium')
    if (width === 900) await page.screenshot({ path: testInfo.outputPath('composer-options.png') })
    await page.keyboard.press('Escape')
    await expect(options).toBeHidden()
    await expect(more).toBeFocused()
    await more.click()
    await page.getByTestId('project-overview').click({ position: { x: 10, y: 10 } })
    await expect(options).toBeHidden()
    await expect(composer.getByRole('textbox')).toHaveValue('Keep this draft')
    await page.screenshot({ path: testInfo.outputPath(`composer-${width}.png`) })
  }

  // Changing available composer space, rather than the window breakpoint, controls the overflow UI.
  await page.setViewportSize({ width: 900, height: 600 })
  await composer.getByRole('button', { name: 'More task options', exact: true }).click()
  await page.keyboard.press('Control+b')
  await expect(composer.getByRole('button', { name: 'More task options', exact: true })).toBeHidden()
  await expect(composer.getByRole('button', { name: /^(Choose a model|Model:)/ })).toHaveAccessibleDescription('OpenCode')
  await expect(composer.getByRole('combobox', { name: 'Reasoning effort', exact: true })).toHaveValue('medium')
  await expect(page.getByRole('group', { name: 'Task options', exact: true })).toBeHidden()
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeInViewport()
  expect(await composer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
})

test('phone composer grows the prompt and keeps controls and attachments contained in short views', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 })
  await page.goto(`/tests/e2e/fixture/?composerModel=${encodeURIComponent(longModel)}`)
  const overview = page.getByTestId('project-overview')
  const composer = page.getByRole('form', { name: 'Start a task' })
  const prompt = composer.getByRole('textbox', { name: 'Task prompt' })
  await chooseProvider(composer.getByRole('button', { name: /^(Choose a model|Model:)/ }), 'opencode', longModel)
  await prompt.fill('Keep this phone draft')

  const desktopPrompt = await prompt.boundingBox()
  expect(desktopPrompt).not.toBeNull()
  expect(desktopPrompt!.height).toBeLessThan(160)

  await page.setViewportSize({ width: 390, height: 360 })
  const phonePrompt = await prompt.boundingBox()
  expect(phonePrompt).not.toBeNull()
  expect(phonePrompt!.height).toBeGreaterThanOrEqual(160)
  expect(phonePrompt!.height).toBeGreaterThan(desktopPrompt!.height)
  await expect(overview).toHaveCSS('padding-left', '12px')
  await expect(overview).toHaveCSS('padding-top', '8px')

  const model = composer.locator('button[aria-label^="Model: Nemotron"]')
  const more = composer.getByRole('button', { name: 'More task options', exact: true })
  const send = composer.getByRole('button', { name: 'Send', exact: true })
  await send.scrollIntoViewIfNeeded()
  await expect(model).toBeInViewport()
  await expect(more).toBeInViewport()
  await expect(send).toBeInViewport()
  const modelBounds = (await model.boundingBox())!
  const moreBounds = (await more.boundingBox())!
  const sendBounds = (await send.boundingBox())!
  expect(Math.abs(modelBounds.y + modelBounds.height / 2 - sendBounds.y - sendBounds.height / 2)).toBeLessThan(2)
  expect(Math.abs(moreBounds.y + moreBounds.height / 2 - sendBounds.y - sendBounds.height / 2)).toBeLessThan(2)

  await prompt.evaluate((element) => {
    const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xw4AAAAASUVORK5CYII='), (value) => value.charCodeAt(0))
    const file = new File([bytes], 'a-very-long-phone-attachment-name.png', { type: 'image/png' })
    const event = new ClipboardEvent('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { items: [{ kind: 'file', type: file.type, getAsFile: () => file }] } })
    element.dispatchEvent(event)
  })
  const attachments = composer.getByRole('list', { name: 'Image attachments' })
  await expect(attachments.getByText('a-very-long-phone-attachment-name.png', { exact: true })).toBeVisible()
  await send.scrollIntoViewIfNeeded()
  await expect(send).toBeInViewport()
  expect(await composer.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(await overview.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  expect(await overview.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)

  await more.click()
  await expect(page.getByRole('group', { name: 'Task options', exact: true })).toBeInViewport()
  await page.keyboard.press('Escape')

  await page.evaluate(() => {
    window.anvil.projects.gitStatus = async () => ({ isRepository: false, gitAvailable: true, pathExists: true })
    window.composerTest.selectProject('project-1')
  })
  const gitAlert = overview.locator('[role="status"]').filter({ hasText: 'This project is not using Git' })
  const initializeGit = gitAlert.getByRole('button', { name: 'Initialize Git repository', exact: true })
  await expect(gitAlert).toHaveCSS('flex-direction', 'column')
  await initializeGit.scrollIntoViewIfNeeded()
  await expect(initializeGit).toBeInViewport()
  expect(await gitAlert.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
})

for (const platform of ['darwin', 'linux']) {
  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    for (const height of [900, 360]) {
      test(`sidebar keeps composer stable: ${platform}, ${reducedMotion}, ${height}px`, async ({ page }, testInfo) => {
        await page.emulateMedia({ reducedMotion })
        await page.setViewportSize({ width: 1300, height })
        await page.goto(`/tests/e2e/fixture/?platform=${platform}`)
        const composer = page.getByRole('form', { name: 'Start a task' })
        const input = composer.getByRole('textbox')
        await input.fill('Keep this draft')
        await page.evaluate(() => document.fonts.ready)
        const initial = await composer.boundingBox()
        expect(initial).not.toBeNull()

        for (const direction of ['collapse', 'expand']) {
          // Start sampling before the key event and cover the entire 180ms transition.
          const samplesPromise = composer.evaluate((element) => new Promise<{ y: number; bottom: number; centerX: number }[]>((resolve) => {
            const samples: { y: number; bottom: number; centerX: number }[] = []
            const start = performance.now()
            function sample(): void {
              const bounds = element.getBoundingClientRect()
              samples.push({ y: bounds.y, bottom: bounds.bottom, centerX: bounds.x + bounds.width / 2 })
              if (performance.now() - start < 450) requestAnimationFrame(sample)
              else resolve(samples)
            }
            element.setAttribute('data-sampling', 'true')
            sample()
          }))
          await expect(composer).toHaveAttribute('data-sampling', 'true')
          await page.keyboard.press(platform === 'darwin' ? 'Meta+b' : 'Control+b')
          const samples = await samplesPromise
          await composer.evaluate(element => element.removeAttribute('data-sampling'))
          console.log(`${platform}/${reducedMotion}/${height}/${direction}: ${JSON.stringify({ first: samples[0], last: samples.at(-1), minY: Math.min(...samples.map(s => s.y)), maxY: Math.max(...samples.map(s => s.y)) })}`)
          await testInfo.attach(`${direction}-geometry`, { body: JSON.stringify(samples), contentType: 'application/json' })
          expect(samples.length).toBeGreaterThan(5)
          if (height === 900) {
            expect.soft(Math.max(...samples.map(sample => Math.abs(sample.y - initial!.y)))).toBeLessThanOrEqual(1)
            expect.soft(Math.max(...samples.map(sample => Math.abs(sample.bottom - initial!.y - initial!.height)))).toBeLessThanOrEqual(1)
          } else {
            expect(Math.min(...samples.map(sample => sample.y))).toBeGreaterThanOrEqual(0)
            expect(Math.max(...samples.map(sample => sample.bottom))).toBeLessThanOrEqual(height)
          }
          expect(Math.abs(samples.at(-1)!.centerX - samples[0].centerX)).toBeGreaterThan(100)
          await expect(input).toBeFocused()
          await expect(input).toHaveValue('Keep this draft')
          if (platform === 'darwin' && direction === 'collapse') {
            const strip = page.locator('main .drag-region')
            await expect(strip).toHaveCSS('-webkit-app-region', 'drag')
            expect(initial!.y).toBeGreaterThanOrEqual(44)
          }
          await composer.getByRole('button', { name: 'Send', exact: true }).scrollIntoViewIfNeeded()
          await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeInViewport()
          await page.screenshot({ path: testInfo.outputPath(`${direction}.png`) })
          await page.getByTestId('project-overview').evaluate(element => { element.scrollTop = 0 })
        }
      })
    }
  }
}

test('macOS title clearance survives overflow and switching workspace views', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 360 })
  await page.goto('/tests/e2e/fixture/?platform=darwin')
  const overview = page.getByTestId('project-overview')
  const composer = page.getByRole('form', { name: 'Start a task' })
  await composer.getByRole('textbox').fill('A line of draft text\n'.repeat(30))
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press('Meta+b')
    await overview.evaluate(element => { element.scrollTop = 0 })
    expect((await composer.boundingBox())!.y).toBeGreaterThanOrEqual(44)
    expect(await overview.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
    const send = composer.getByRole('button', { name: 'Send', exact: true })
    await send.scrollIntoViewIfNeeded()
    await expect(send).toBeInViewport()
  }
  await page.getByRole('button', { name: 'Open task: Polish task cards', exact: true }).click()
  await page.keyboard.press('Meta+b')
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'Polish task cards' })).toBeVisible()
  await expect(main.locator(':scope > .drag-region')).toBeVisible()
  await expect(main).toHaveCSS('padding-top', '0px')
  await page.keyboard.press('Meta+b')
  await expect(main.locator('.drag-region')).toHaveCount(0)
  await expect(main.getByRole('heading', { name: 'Polish task cards' })).toBeVisible()
})
