import { expect, test } from '@playwright/test'

const review = '/tests/e2e/fixture/?scenario=review'
const ship = (page: import('@playwright/test').Page) => page.getByRole('button', { name: /^Ship( to |$)/ })

test('Ship needs a hold, then commits and pushes', async ({ page }) => {
  await page.goto(review)
  await ship(page).click()
  await expect(page.getByLabel('Task status', { exact: true })).toContainText('Ready to ship')
  await ship(page).click({ delay: 1000 })
  await expect(page.getByText('Shipped & pushed', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Undo ship', exact: true })).toHaveCount(0)
})

test('Ship names its target branch and an unpushed ship can be undone', async ({ page }) => {
  await page.goto(`${review}&shipWithoutPush=1`)
  await expect(page.getByRole('button', { name: 'Ship to main', exact: true })).toBeEnabled()
  await ship(page).click({ delay: 1000 })
  await expect(page.getByLabel('Task status', { exact: true })).toContainText('Shipped')
  await page.getByRole('button', { name: 'Undo ship', exact: true }).click()
  await expect(page.getByLabel('Task status', { exact: true })).toContainText('Ready to ship')
  await expect(page.getByRole('button', { name: 'Ship to main', exact: true })).toBeEnabled()
})

test('undo errors stay next to the button', async ({ page }) => {
  await page.goto(`${review}&undoShipFailure=1&shipWithoutPush=1`)
  await ship(page).click({ delay: 1000 })
  await page.getByRole('button', { name: 'Undo ship', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'has moved since this task was shipped' })).toBeVisible()
  await expect(page.getByLabel('Task status', { exact: true })).toContainText('Shipped')
})

test('failed checks warn on Ship and can be sent back to the agent', async ({ page }) => {
  await page.goto(`${review}&checks=1&checksFailure=1&checksDelay=200`)
  await page.evaluate(() => {
    const steers: unknown[] = []
    Object.assign(window, { steers })
    window.anvil.tasks.steer = async (input) => { steers.push(input) }
  })
  await page.getByRole('button', { name: 'Run checks', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Checks failed', exact: true })).toBeVisible()
  await expect(ship(page)).toHaveAttribute('title', /Checks failed for these changes/)
  await page.getByRole('button', { name: 'Checks failed', exact: true }).click()
  const results = page.getByRole('dialog', { name: 'Check results' })
  await expect(results.getByLabel('Check output')).toContainText('showBranch')
  await results.getByRole('button', { name: 'Send failure to agent', exact: true }).click()
  await expect(results).toHaveCount(0)
  const [steer] = await page.evaluate(() => (window as unknown as { steers: { taskId: string; message: string }[] }).steers)
  expect(steer.taskId).toBe('review')
  expect(steer.message).toContain('npm run typecheck && npm test')
  expect(steer.message).toContain("'showBranch' does not exist")
})

test('passing checks show next to Ship', async ({ page }) => {
  await page.goto(`${review}&checks=1&checksDelay=200`)
  await page.getByRole('button', { name: 'Run checks', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Checks passed', exact: true })).toBeVisible()
  await expect(ship(page)).not.toHaveAttribute('title', /Checks failed/)
})

test('risky files are called out above the diff and jump to the file', async ({ page }) => {
  await page.goto(`${review}&risky=1`)
  await page.getByRole('tab', { name: /^Changes/ }).click()
  const flags = page.getByRole('group', { name: 'Changes to look at' })
  await expect(flags.getByRole('button')).toHaveText(['Secrets or env file1', 'Database migration1', 'Dependency lockfile1'])
  await flags.getByRole('button', { name: /Secrets or env file/ }).click()
  await expect(page.getByRole('region', { name: '.env.production' })).toBeInViewport()
})

test('wide windows show changes beside the output and can fold them back into a tab', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.goto(review)
  const pane = page.getByRole('complementary', { name: 'Changes pane' })
  await expect(pane.getByRole('region', { name: 'src/sidebar.ts' })).toBeVisible()
  await expect(page.getByRole('log', { name: 'Task output' })).toBeVisible()
  await expect(page.getByRole('tab', { name: /^Changes/ })).toHaveCount(0)
  await page.getByRole('button', { name: 'Hide changes' }).click()
  await expect(pane).toHaveCount(0)
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await expect(page.getByRole('region', { name: 'src/sidebar.ts' })).toBeVisible()
  await page.getByRole('button', { name: 'Changes beside output' }).click()
  await expect(pane).toBeVisible()
})

test('the ship queue lists ready tasks and ships the ones that passed checks', async ({ page }) => {
  await page.goto(`${review}&checks=1&checksDelay=100`)
  await page.getByRole('button', { name: /tasks? ready to ship/ }).click()
  await expect(page.getByRole('heading', { name: 'Ready to ship', exact: true })).toBeVisible()
  const list = page.getByRole('list', { name: 'Tasks ready to ship' })
  const row = list.getByRole('listitem').filter({ hasText: 'Review sidebar changes' })
  await expect(row).toBeVisible()
  const shipPassing = page.getByRole('button', { name: /^Ship \d+ passing$/ })
  await expect(shipPassing).toHaveText('Ship 0 passing')
  await expect(shipPassing).toBeDisabled()
  await row.getByRole('button', { name: 'Run checks', exact: true }).click()
  await expect(row.getByRole('button', { name: 'Checks passed', exact: true })).toBeVisible()
  await expect(shipPassing).toHaveText('Ship 1 passing')
  await shipPassing.click()
  await expect(row).toHaveCount(0)
})
