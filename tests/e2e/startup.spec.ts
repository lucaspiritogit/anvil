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

test('keeps the skeleton visible and retries after a disconnected startup request', async ({ page }) => {
  await page.goto(`${fixture}?snapshotFailure`)
  const skeleton = page.getByRole('status', { name: 'Loading Anvil' })
  await expect(skeleton).toBeVisible()
  await expect(page.getByRole('main')).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)

  await expect(page.getByRole('main')).toBeVisible()
  await expect(skeleton).toHaveCount(0)
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('keeps the skeleton visible after an initialization failure', async ({ page }) => {
  await page.goto(`${fixture}?servicesFailure`)
  const skeleton = page.getByRole('status', { name: 'Loading Anvil' })
  await expect(skeleton).toBeVisible()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.getByRole('main')).toBeVisible()
  await expect(skeleton).toHaveCount(0)
})
