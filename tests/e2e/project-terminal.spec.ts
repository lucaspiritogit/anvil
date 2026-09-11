import { expect, test } from '@playwright/test'

for (const [platform, modifier] of [['darwin', 'Meta'], ['linux', 'Control']] as const) {
  test(`${modifier}+T toggles the project terminal and close ends the session`, async ({ page }) => {
    await page.goto(`/tests/e2e/fixture/?platform=${platform}`)
    await expect(page.getByRole('textbox', { name: 'Task prompt' })).toBeVisible()
    await page.keyboard.press(`${modifier}+t`)
    const panel = page.getByRole('region', { name: 'Project terminal', exact: true })
    await expect(panel).toBeVisible()
    await expect(panel.locator('canvas')).toBeVisible()
    await page.keyboard.press(`${modifier}+t`)
    await expect(panel).toBeHidden()
    await page.keyboard.press(`${modifier}+t`)
    await expect(panel).toBeVisible()
    await page.getByRole('button', { name: 'Close project terminal' }).click()
    await expect(panel).toHaveCount(0)
  })
}

test('terminal launch failure is visible', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/')
  await page.evaluate(() => { window.anvil.terminals.create = async () => { throw new Error('Shell unavailable') } })
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toBeVisible()
  await page.keyboard.press('Control+t')
  await expect(page.getByRole('alert')).toContainText('Could not open the project terminal')
})
