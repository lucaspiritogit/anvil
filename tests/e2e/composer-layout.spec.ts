import { expect, test } from '@playwright/test'
import { restoreComposerSelection } from './composer-setup'

test.beforeEach(async ({ page }) => restoreComposerSelection(page))

const longModel = 'nvidia/nemotron-3-ultra-550b-a55b:free'

test('compact composer keeps the model and Send aligned, with other controls behind More', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/')
  await page.evaluate((model) => {
    window.anvil.agents.models = async (agentId) => ({ agentId, models: [model] })
  }, longModel)
  const composer = page.getByRole('form', { name: 'Start a task' })
  await composer.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('opencode')
  await composer.getByRole('button', { name: 'Model: model', exact: true }).click()
  await page.getByRole('dialog', { name: 'Choose model' }).getByRole('button', { name: 'nemotron-3-ultra-550b-a55b:free', exact: true }).click()
  await composer.getByRole('textbox').fill('Keep this draft')

  for (const width of [900, 700, 600]) {
    await page.setViewportSize({ width, height: 600 })
    const more = composer.getByRole('button', { name: 'More task options', exact: true })
    await expect(more).toBeVisible()
    await expect(composer.getByRole('combobox', { name: 'Agent', exact: true })).toBeHidden()
    await expect(composer.getByRole('combobox', { name: 'Thinking level', exact: true })).toBeHidden()
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
    await options.getByRole('combobox', { name: 'Thinking level', exact: true }).selectOption('Medium')
    if (width === 900) await page.screenshot({ path: testInfo.outputPath('composer-options.png') })
    await page.keyboard.press('Escape')
    await expect(options).toBeHidden()
    await expect(more).toBeFocused()
    await more.click()
    await page.getByRole('main').getByRole('heading', { name: 'Anvil', exact: true }).click()
    await expect(options).toBeHidden()
    await expect(composer.getByRole('textbox')).toHaveValue('Keep this draft')
    await page.screenshot({ path: testInfo.outputPath(`composer-${width}.png`) })
  }

  // Changing available composer space, rather than the window breakpoint, controls the overflow UI.
  await page.setViewportSize({ width: 900, height: 600 })
  await composer.getByRole('button', { name: 'More task options', exact: true }).click()
  await page.keyboard.press('Control+b')
  await expect(composer.getByRole('button', { name: 'More task options', exact: true })).toBeHidden()
  await expect(composer.getByRole('combobox', { name: 'Agent', exact: true })).toHaveValue('opencode')
  await expect(composer.getByRole('combobox', { name: 'Thinking level', exact: true })).toHaveValue('Medium')
  await expect(page.getByRole('group', { name: 'Task options', exact: true })).toBeHidden()
})
