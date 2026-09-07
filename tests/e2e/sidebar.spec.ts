import { expect, test } from '@playwright/test'

const fixture = '/tests/e2e/fixture/'

test('task status icons and highlights remain visible when selected, hovered, and settled', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 900 })
  await page.goto(fixture)
  const sidebar = page.getByRole('complementary')
  const approved = sidebar.getByRole('button', { name: 'Open task: Polish task cards', exact: true })
  const review = sidebar.getByRole('button', { name: 'Open task: Review sidebar changes', exact: true })
  const failed = sidebar.getByRole('button', { name: 'Open task: Retry provider setup', exact: true })
  await expect(approved.getByRole('img', { name: 'Approved', exact: true })).toHaveCSS('color', 'rgb(124, 195, 121)')
  await expect(review.getByRole('img', { name: 'Ready for review', exact: true })).toHaveClass(/text-orange-400/)
  await expect(failed.getByRole('img', { name: 'Failed', exact: true })).toHaveCSS('color', 'rgb(224, 108, 117)')
  await expect(approved.locator('..')).toHaveClass(/bg-ok\/8/)
  await expect(review.locator('..')).toHaveClass(/bg-orange-400\/8/)
  await approved.click()
  await approved.hover()
  await expect(approved.getByRole('img', { name: 'Approved', exact: true })).toBeVisible()
  await expect(approved.locator('..')).toHaveClass(/bg-ok\/8/)
  await expect(approved.locator('..')).toHaveClass(/outline-offset-1/)
  await page.screenshot({ path: testInfo.outputPath('sidebar-task-statuses.png') })
  await sidebar.getByRole('button', { name: 'Settle task: Polish task cards', exact: true }).click()
  const settled = sidebar.getByRole('region', { name: 'Settled tasks' })
  await settled.getByRole('button', { name: /^Settled/ }).click()
  const settledTask = settled.getByRole('button', { name: 'Open task: Polish task cards', exact: true })
  await expect(settledTask.getByRole('img', { name: 'Approved', exact: true })).toBeVisible()
  await expect(settledTask.locator('..')).toHaveClass(/bg-ok\/8/)
})

test('task updates replace the sidebar status without leaving stale success indicators', async ({ page }) => {
  await page.goto(fixture)
  const task = page.getByRole('button', { name: 'Open task: Build streaming support', exact: true })
  const scenarios = [
    { status: 'succeeded', deliveryStatus: 'reviewable', label: 'Ready for review' },
    { status: 'succeeded', deliveryStatus: 'approved', label: 'Approved' },
    { status: 'running', deliveryStatus: 'approved', label: 'Working' },
    { status: 'failed', deliveryStatus: 'reviewable', label: 'Failed' },
    { status: 'succeeded', deliveryStatus: 'failed', label: 'Failed' },
    { status: 'cancelled', deliveryStatus: 'approved', label: null },
    { status: 'succeeded', deliveryStatus: 'no_changes', label: null }
  ] as const
  await expect(task.getByRole('img', { name: 'Working', exact: true })).toBeVisible()
  for (const scenario of scenarios) {
    await page.evaluate(async ({ status, deliveryStatus }) => {
      const current = (await window.anvil.tasks.list()).find((task) => task.id === 'running')!
      window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...current, status, deliveryStatus } }))
    }, scenario)
    if (scenario.label) {
      await expect(task.getByRole('img', { name: scenario.label, exact: true })).toBeVisible()
      await expect(task.getByRole('img')).toHaveCount(1)
    } else {
      await expect(task.getByRole('img')).toHaveCount(0)
    }
    if (scenario.label !== 'Approved' && scenario.label !== 'Ready for review') {
      await expect(task.locator('..')).not.toHaveClass(/bg-(ok|orange-400)\/8/)
    }
  }
})

test('search filters active and settled tasks by title, project, or branch', async ({ page }) => {
  await page.goto(fixture)
  const sidebar = page.getByRole('complementary')
  await sidebar.getByRole('searchbox', { name: 'Search tasks' }).fill('polish')
  await expect(sidebar.getByRole('button', { name: 'Open task: Polish task cards', exact: true })).toBeVisible()
  await expect(sidebar.getByRole('button', { name: 'Open task: Build streaming support', exact: true })).toHaveCount(0)
  await sidebar.getByRole('searchbox').fill('Workbench')
  await expect(sidebar.getByRole('button', { name: 'Open task: Layout test task', exact: true })).toBeVisible()
  await expect(sidebar.getByRole('button', { name: 'Open task: Polish task cards', exact: true })).toHaveCount(0)
  await sidebar.getByRole('searchbox').fill('anvil/polish-task-cards')
  await expect(sidebar.getByRole('button', { name: 'Open task: Polish task cards', exact: true })).toBeVisible()
  await sidebar.getByRole('searchbox').fill('old logs')
  await expect(sidebar.getByRole('button', { name: 'Open task: Clean up old logs', exact: true })).toBeVisible()
  await sidebar.getByRole('searchbox').fill('nothing matches')
  await expect(sidebar.getByText('No matching tasks.')).toBeVisible()
  await sidebar.getByRole('button', { name: 'Clear search' }).click()
  await expect(sidebar.getByRole('button', { name: 'Open task: Build streaming support', exact: true })).toBeVisible()
})

test('project filters and opening tasks switch project context correctly', async ({ page }) => {
  await page.goto(fixture)
  const sidebar = page.getByRole('complementary')
  const filters = sidebar.getByRole('navigation', { name: 'Filter tasks by project' })
  await filters.getByRole('button', { name: 'Workbench', exact: true }).click()
  await expect(sidebar.getByRole('navigation', { name: 'Active tasks' }).getByRole('article')).toHaveCount(2)
  await expect(sidebar.getByRole('button', { name: 'Open task: Polish task cards', exact: true })).toHaveCount(0)
  await filters.getByRole('button', { name: 'All', exact: true }).click()
  await sidebar.getByRole('button', { name: 'Open task: Polish task cards', exact: true }).click()
  await expect(page.getByRole('main').getByText('/tmp/anvil', { exact: true })).toBeVisible()
  await sidebar.getByRole('button', { name: 'Open task: Layout test task', exact: true }).click()
  await expect(page.getByRole('main').getByText('/tmp/workbench', { exact: true })).toBeVisible()
})

test('hover settling moves reviewed work into the bottom accordion without closing it', async ({ page }) => {
  await page.goto(fixture)
  const sidebar = page.getByRole('complementary')
  const tasks = sidebar.getByRole('navigation', { name: 'Active tasks' })
  const task = tasks.getByRole('button', { name: 'Open task: Polish task cards', exact: true })
  await task.click()
  await task.hover()
  await tasks.getByRole('button', { name: 'Settle task: Polish task cards', exact: true }).click()
  await expect(task).toHaveCount(0)
  await expect(page.getByRole('main').getByRole('heading', { name: 'Polish task cards' })).toBeVisible()
  const settled = sidebar.getByRole('region', { name: 'Settled tasks' })
  const toggle = settled.getByRole('button', { name: /^Settled/ })
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await toggle.click()
  await expect(settled.getByRole('button', { name: 'Open task: Polish task cards', exact: true })).toBeVisible()
  await expect(settled.getByRole('button', { name: 'Open task: Clean up old logs', exact: true })).toBeVisible()
  await toggle.click()
  await expect(settled.getByRole('button', { name: 'Open task: Polish task cards', exact: true })).toHaveCount(0)
  await expect(tasks.getByRole('button', { name: /^Settle task: (Build streaming support|Review sidebar changes|Retry provider setup)$/ })).toHaveCount(0)
})

test('settlement failure preserves the task and reports an error', async ({ page }) => {
  await page.goto(`${fixture}?settleFailure=1`)
  const task = page.getByRole('button', { name: 'Open task: Polish task cards', exact: true })
  await task.hover()
  await page.getByRole('button', { name: 'Settle task: Polish task cards', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Settlement failed for testing')
  await expect(task).toBeVisible()
})

test('Settings is a seamless icon row and stays reachable in a short window', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 500 })
  await page.goto(fixture)
  const settings = page.getByRole('complementary').getByRole('button', { name: 'Settings', exact: true })
  await expect(settings).toBeInViewport()
  await expect(settings).toHaveCSS('border-top-width', '0px')
  await expect(settings.locator('svg')).toHaveCount(1)
  await page.screenshot({ path: testInfo.outputPath('sidebar.png') })
  await settings.click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
})
