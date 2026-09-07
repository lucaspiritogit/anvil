import { expect, test } from '@playwright/test'
import { restoreComposerSelection } from './composer-setup'

test.beforeEach(async ({ page }) => restoreComposerSelection(page))

test('Codex uses the existing OpenAI artwork and OpenCode keeps its logo', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/')
  const composer = page.getByRole('form', { name: 'Start a task' })
  const agent = composer.getByRole('combobox', { name: 'Agent', exact: true })
  await agent.selectOption('codex')
  const indicator = agent.locator('..').locator('span[aria-hidden="true"]')
  await expect(indicator).toHaveCSS('mask-image', /openai\.svg/)
  await expect(indicator).toHaveCSS('width', '16px')
  await expect(indicator).toHaveCSS('height', '16px')
  const artwork = await indicator.evaluate((element) => {
    const image = new Image()
    image.src = getComputedStyle(element).maskImage.slice(5, -2)
    return image.decode().then(() => image.naturalWidth > 0)
  })
  expect(artwork).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('codex-icon.png') })
  await agent.selectOption('opencode')
  const opencode = agent.locator('..').locator('img')
  await expect(opencode).toHaveAttribute('src', /opencode\.svg/)
  expect(await opencode.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true)
})
