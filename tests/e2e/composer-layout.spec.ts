import { expect, test } from '@playwright/test'
import { chooseProvider, restoreComposerSelection } from './composer-setup'

test.beforeEach(async ({ page }) => restoreComposerSelection(page))

const longModel = 'nvidia/nemotron-3-ultra-550b-a55b:free'

test('compact composer keeps the model and Send aligned, with other controls behind More', async ({ page }, testInfo) => {
  await page.goto(`/tests/e2e/fixture/?composerModel=${encodeURIComponent(longModel)}`)
  const composer = page.getByRole('form', { name: 'Start a task' })
  await chooseProvider(composer.getByRole('button', { name: /^(Choose a model|Model:)/ }), 'opencode')
  await composer.getByRole('button', { name: 'Model: model', exact: true }).click()
  await page.getByRole('dialog', { name: 'Choose model' }).getByRole('button', { name: 'nemotron-3-ultra-550b-a55b:free', exact: true }).click()
  await composer.getByRole('textbox').fill('Keep this draft')

  for (const width of [900, 700, 600]) {
    await page.setViewportSize({ width, height: 600 })
    const more = composer.getByRole('button', { name: 'More task options', exact: true })
    await expect(more).toBeVisible()
    await expect(composer.getByRole('button', { name: 'Agent', exact: true })).toHaveCount(0)
    await expect(composer.getByRole('combobox', { name: 'Reasoning effort', exact: true })).toBeHidden()
    const model = composer.getByRole('button', { name: 'Model: nemotron-3-ultra-550b-a55b:free', exact: true })
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
