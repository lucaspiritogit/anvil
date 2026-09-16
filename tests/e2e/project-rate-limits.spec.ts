import { expect, test } from '@playwright/test'

test('shows remaining weekly Codex limits below the composer', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/')
  const overview = page.getByTestId('project-overview')
  const composer = page.getByRole('form', { name: 'Start a task' })
  const limits = page.getByRole('region', { name: 'Codex usage limits' })
  const meter = limits.getByRole('meter', { name: 'Weekly' })

  await expect(limits).toContainText('ChatGPT')
  await expect(limits).toContainText('Weekly')
  await expect(limits).toContainText('74% left')
  await expect(meter).toHaveAttribute('aria-valuenow', '74')
  await expect(limits).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  expect((await limits.boundingBox())!.y).toBeGreaterThan((await composer.boundingBox())!.y)

  await page.setViewportSize({ width: 390, height: 700 })
  await limits.scrollIntoViewIfNeeded()
  expect(await overview.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('codex-weekly-limit.png') })
})
