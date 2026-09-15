import { expect, test } from '@playwright/test'

const fixture = '/tests/e2e/fixture/'

test('analytics navigation loads the local month and renders workspace metrics', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto(fixture)
  const settings = page.getByRole('button', { name: 'Settings', exact: true })
  const analytics = page.getByRole('button', { name: 'Analytics', exact: true })
  const settingsBox = await settings.boundingBox()
  const analyticsBox = await analytics.boundingBox()
  expect(analyticsBox!.y).toBeGreaterThan(settingsBox!.y)

  await analytics.focus()
  await expect(analytics).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(analytics).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible()
  await expect(page.getByText('125K', { exact: true })).toBeVisible()
  await expect(page.getByText('$4.25', { exact: true })).toBeVisible()
  await expect(page.getByRole('note')).toContainText('1 task has no cost data')
  await expect(page.getByText('GPT 5.2', { exact: true }).first()).toBeVisible()
  await expect(page.getByText('80% success', { exact: false })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Top projects' })).toContainText('Anvil')
  await expect(page.getByRole('region', { name: 'Code changes' })).toContainText('+350')

  const expectedRange = await page.evaluate(() => {
    const now = new Date()
    return {
      startAt: new Date(now.getFullYear(), now.getMonth(), 1).getTime(),
      endAt: new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime()
    }
  })
  await expect.poll(() => page.evaluate(() => window.analyticsTest.requests[0])).toEqual(expectedRange)

  await page.getByLabel('Start date').fill('2024-02-01')
  await page.getByLabel('End date').fill('2024-02-29')
  await expect.poll(() => page.evaluate(() => window.analyticsTest.requests.at(-1))).toEqual({
    startAt: new Date(2024, 1, 1).getTime(),
    endAt: new Date(2024, 2, 1).getTime()
  })
  await page.getByRole('button', { name: 'Previous period' }).click()
  await expect(page.getByLabel('Start date')).toHaveValue('2024-01-03')
  await expect(page.getByLabel('End date')).toHaveValue('2024-01-31')
  await page.getByRole('button', { name: 'This month' }).click()
  await expect(page.getByLabel('Start date')).not.toHaveValue('2024-01-03')

  await settings.click()
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible()
  await page.getByRole('button', { name: 'Back to workspace' }).click()
  await expect(page.getByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible()
})

test('analytics shows retryable errors and an informative empty period', async ({ page }) => {
  await page.goto(`${fixture}?analyticsError`)
  await page.getByRole('button', { name: 'Analytics', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Analytics fixture unavailable')
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByText('125K', { exact: true })).toBeVisible()

  await page.goto(`${fixture}?analyticsEmpty&noProjects`)
  await page.getByRole('button', { name: 'Analytics', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible()
  await expect(page.getByText('No tasks started during this period.', { exact: false })).toBeVisible()
  await expect(page.getByText('No model data reported.', { exact: true })).toBeVisible()
})

test('analytics remains usable in mobile navigation and does not overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 720 })
  await page.goto(fixture)
  await page.getByRole('button', { name: 'Open navigation' }).click()
  const analytics = page.getByRole('button', { name: 'Analytics', exact: true })
  await analytics.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Open navigation' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible()
  await expect(page.getByLabel('Start date')).toBeVisible()
  await expect(page.getByLabel('End date')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await page.screenshot({ path: testInfo.outputPath('analytics-mobile.png'), fullPage: true })
})
