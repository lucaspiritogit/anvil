import { expect, test, type Page } from '@playwright/test'

async function openOutputTask(page: Page, task: string, extra = ''): Promise<void> {
  await page.goto(`/tests/e2e/fixture/?scenario=output&task=${task}${extra}`)
}

test('a settled task mounts no steering composer in either panel', async ({ page }, testInfo) => {
  await openOutputTask(page, 'settled')
  const aside = page.getByRole('region', { name: 'Output', exact: true })
  await expect(page.getByRole('heading', { name: 'Clean up old logs' })).toBeVisible()
  await expect(page.getByRole('form', { name: 'Steer task' })).toHaveCount(0)
  await page.getByRole('tab', { name: 'Changes' }).click()
  await expect(page.getByRole('form', { name: 'Steer task' })).toHaveCount(0)
  await page.getByRole('tab', { name: 'Output' }).click()
  await expect(page.getByRole('form', { name: 'Steer task' })).toHaveCount(0)
  const log = page.getByRole('log')
  await expect(log).toBeVisible()
  const asideBounds = (await aside.boundingBox())!
  const logBounds = (await log.boundingBox())!
  expect(logBounds.y + logBounds.height).toBeGreaterThanOrEqual(asideBounds.y + asideBounds.height - 1)
  await page.screenshot({ path: testInfo.outputPath('settled-no-composer.png'), fullPage: true })
})

test('failed and cancelled tasks still offer the help composer', async ({ page }) => {
  for (const [task, extra] of [['failed', ''], ['failed', '&cancelled=1']] as const) {
    await openOutputTask(page, task, extra)
    const composer = page.getByRole('form', { name: 'Steer task' })
    await expect(composer).toBeVisible()
    await expect(composer.getByRole('textbox', { name: 'Message to agent' })).toHaveAttribute('placeholder', 'Help this task continue...')
  }
})
