import { expect, test } from '@playwright/test'

const fixture = '/tests/e2e/fixture/'

test('analytics navigation renders workspace metrics and range presets', async ({ page }) => {
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
  await expect(page.getByRole('button', { name: '30d', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('region', { name: 'Tokens over time' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Token mix per day' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Task outcomes' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Top projects' })).toContainText('Anvil')

  const expectedPeriods = await page.evaluate(() => {
    const format = (date: Date) => {
      const year = String(date.getFullYear()).padStart(4, '0')
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${year}-${month}-${day}`
    }
    const now = new Date()
    const lastStart = new Date(now.getFullYear(), now.getMonth() - 1, 1, 12)
    const lastEnd = new Date(now.getFullYear(), now.getMonth(), 0, 12)
    const previousEnd = new Date(lastStart)
    previousEnd.setDate(previousEnd.getDate() - 1)
    const previousStart = new Date(previousEnd)
    previousStart.setDate(previousStart.getDate() - lastEnd.getDate() + 1)
    return {
      last: { start: format(lastStart), end: format(lastEnd) },
      previous: { start: format(previousStart), end: format(previousEnd) },
      current: {
        start: format(new Date(now.getFullYear(), now.getMonth(), 1, 12)),
        end: format(new Date(now.getFullYear(), now.getMonth() + 1, 0, 12))
      }
    }
  })
  await page.getByRole('button', { name: 'Last month', exact: true }).click()
  await expect(page.getByLabel('Start date')).toHaveValue(expectedPeriods.last.start)
  await expect(page.getByLabel('End date')).toHaveValue(expectedPeriods.last.end)
  await page.getByRole('button', { name: 'Previous period' }).click()
  await expect(page.getByLabel('Start date')).toHaveValue(expectedPeriods.previous.start)
  await expect(page.getByLabel('End date')).toHaveValue(expectedPeriods.previous.end)
  await page.getByRole('button', { name: 'This month' }).click()
  await expect(page.getByLabel('Start date')).toHaveValue(expectedPeriods.current.start)
  await expect(page.getByLabel('End date')).toHaveValue(expectedPeriods.current.end)

  await settings.click()
  await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible()
  await page.getByRole('button', { name: 'Back to workspace' }).click()
  await expect(page.getByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible()
})

test('analytics handles inverted and empty date ranges', async ({ page }) => {
  await page.goto(fixture)
  await page.getByRole('button', { name: 'Analytics', exact: true }).click()
  const tomorrow = await page.evaluate(() => {
    const date = new Date()
    date.setDate(date.getDate() + 1)
    const year = String(date.getFullYear()).padStart(4, '0')
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  })
  await page.getByLabel('Start date').fill(tomorrow)
  await expect(page.getByRole('alert')).toContainText('Start date must not be after end date')
  await expect(page.getByRole('button', { name: 'Previous period' })).toBeDisabled()
  await page.getByRole('button', { name: '7d', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)

  await page.goto(`${fixture}?analyticsEmpty`)
  await page.getByRole('button', { name: 'Analytics', exact: true }).click()
  await expect(page.getByRole('region', { name: 'No activity' })).toContainText('No tasks started during this period')
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
