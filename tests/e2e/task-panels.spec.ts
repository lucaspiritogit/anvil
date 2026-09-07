import { expect, test } from '@playwright/test'

for (const viewport of [{ width: 1440, height: 900 }, { width: 900, height: 500 }]) {
  for (const scenario of ['output', 'review']) {
    test(`task opens Output with Changes available at ${viewport.width}px, ${scenario}`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport)
      await page.goto(`/tests/e2e/fixture/?scenario=${scenario}`)
      const outputTab = page.getByRole('tab', { name: 'Output', exact: true })
      const changesTab = page.getByRole('tab', { name: /^Changes/ })
      await expect(outputTab).toBeVisible()
      await expect(outputTab).toHaveAttribute('aria-selected', 'true')
      await expect(changesTab).toBeVisible()
      await expect(changesTab).toBeEnabled()
      if (scenario === 'output') await expect(changesTab).toHaveText('Changes · 0')
      await expect(page.getByRole('log', { name: 'Task output' })).toBeVisible()
      await expect(page.getByRole('region', { name: 'Code changes' })).toBeHidden()
      await page.screenshot({ path: testInfo.outputPath('default-output.png') })
      await changesTab.click()
      await expect(changesTab).toHaveAttribute('aria-selected', 'true')
      await expect(page.getByRole('region', { name: 'Code changes' })).toBeVisible()
      if (scenario === 'review') {
        await expect(page.getByRole('combobox', { name: 'Changed file' })).toBeVisible()
      } else {
        await expect(page.getByText('There is no final diff available for review.')).toBeVisible()
      }
      await outputTab.click()
      await expect(page.getByRole('log', { name: 'Task output' })).toBeVisible()
    })
  }
}

test('switching to another task resets the active tab to Output', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await page.getByRole('button', { name: /Build streaming support/ }).click()
  await expect(page.getByRole('tab', { name: 'Output', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('log', { name: 'Task output' })).toBeVisible()
  await expect(page.getByRole('tab', { name: /^Changes/ })).toBeEnabled()
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await expect(page.getByText('The final task diff will appear here when it is ready for review.')).toBeVisible()
})
