import { expect, test } from '@playwright/test'

const fixture = '/tests/e2e/fixture/'

test('paints the shell skeleton until main reports readiness', async ({ page }) => {
  await page.goto(`${fixture}?servicesDelay=2000`)
  const skeleton = page.getByRole('status', { name: 'Loading Anvil' })
  await expect(skeleton).toBeVisible()
  await expect(page.getByRole('main')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'New task', exact: true })).toHaveCount(0)

  await expect(page.getByRole('main')).toBeVisible()
  await expect(skeleton).toHaveCount(0)
})

test('surfaces an initialization failure and recovers through Retry', async ({ page }) => {
  await page.goto(`${fixture}?servicesFailure`)
  const alert = page.getByRole('alert')
  await expect(alert).toHaveText('Anvil services failed to start')
  await expect(page.getByRole('main')).toHaveCount(0)

  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByRole('main')).toBeVisible()
  await expect(alert).toHaveCount(0)
})
