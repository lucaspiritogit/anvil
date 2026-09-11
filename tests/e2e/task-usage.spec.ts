import { expect, test } from '@playwright/test'

test('task usage shows cached input and explains cumulative request totals', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&taskUsage=1')
  const main = page.getByRole('main')
  const cached = main.locator('[title="638.2K cached input"]')
  await expect(cached.getByText('Cached', { exact: true })).toBeVisible()
  await expect(cached.getByText('638.2K', { exact: true })).toBeVisible()
  await expect(main.getByText(/^688\.8K\s*in$/)).toBeVisible()
  await expect(main.getByText(/^3\.6K\s*out$/)).toBeVisible()
  const tokens = main.locator('[title*="688,809 input"]')
  await expect(tokens).toHaveAttribute('title', /50,601 uncached/)
  await expect(tokens).toHaveAttribute('title', /across model requests/)
  await page.screenshot({ path: testInfo.outputPath('task-usage.png') })
})

test('context occupancy appears beside Compact above the steering input', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&taskUsage=1&contextUsage=1')
  const statistics = page.getByRole('group', { name: 'Task statistics' })
  const composer = page.getByRole('form', { name: 'Steer task' })
  const controls = composer.getByRole('group', { name: 'Task context controls' })
  const compact = controls.getByRole('button', { name: 'Compact', exact: true })
  const context = controls.locator('[title*="in the current session"]')
  const input = composer.getByRole('textbox', { name: 'Message to agent' })
  await expect(statistics.getByText('Context', { exact: true })).toHaveCount(0)
  await expect(controls.locator(':scope > *')).toHaveCount(2)
  await expect(controls.locator(':scope > *').nth(0)).toHaveText('Compact')
  await expect(controls.locator(':scope > *').nth(1)).toContainText('Context67%')
  await expect(context).toHaveAttribute('title', /142K \/ 213K/)
  const controlsBounds = (await controls.boundingBox())!
  const compactBounds = (await compact.boundingBox())!
  const contextBounds = (await context.boundingBox())!
  const inputBounds = (await input.boundingBox())!
  expect(controlsBounds.y + controlsBounds.height).toBeLessThanOrEqual(inputBounds.y)
  expect(contextBounds.x).toBeGreaterThanOrEqual(compactBounds.x + compactBounds.width)
  await expect(compact).toBeEnabled()
  await compact.click()
  await page.screenshot({ path: testInfo.outputPath('task-context.png') })
  await page.goto('/tests/e2e/fixture/?scenario=output&contextUsage=1&steering=1&running=1')
  await expect(page.getByRole('button', { name: 'Compact', exact: true })).toBeDisabled()
  await page.goto('/tests/e2e/fixture/?scenario=output')
  await expect(page.getByRole('main').locator('[title*="in the current session"]')).toHaveCount(0)
})

test('workspace context settings default to 75 percent and save changes', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Providers', exact: true }).click()
  const toggle = page.getByLabel('Auto-compact task context')
  const threshold = page.getByLabel('Context threshold (%)')
  await expect(toggle).toBeChecked()
  await expect(threshold).toHaveValue('75')
  await threshold.fill('85')
  await toggle.uncheck()
  await expect(threshold).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('context-settings.png') })
  await toggle.check()
  await expect(threshold).toHaveValue('85')
})
