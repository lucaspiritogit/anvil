import { expect, test } from '@playwright/test'

test('task usage shows cached input and explains cumulative request totals', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&taskUsage=1')
  const main = page.getByRole('main')
  await expect(main.getByText('638.2K cached input', { exact: true })).toBeVisible()
  await expect(main.getByText(/^688\.8K\s*in$/)).toBeVisible()
  await expect(main.getByText(/^3\.6K\s*out$/)).toBeVisible()
  const tokens = main.locator('[title*="688,809 input"]')
  await expect(tokens).toHaveAttribute('title', /50,601 uncached/)
  await expect(tokens).toHaveAttribute('title', /across model requests/)
  await page.screenshot({ path: testInfo.outputPath('task-usage.png') })
})
