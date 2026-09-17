import { expect, test } from '@playwright/test'

const fixture = '/tests/e2e/fixture/'

test('mobile navigation overlays a full-width workspace and supports every dismissal path', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 700 })
  await page.goto(fixture)
  const sidebar = page.locator('aside[aria-label="Task sidebar"]')
  const openNavigation = page.getByRole('button', { name: 'Open navigation' })
  const workspace = page.locator('main')

  await expect(sidebar).not.toBeInViewport()
  await expect(sidebar).toHaveAttribute('aria-hidden', 'true')
  await expect(openNavigation).toBeVisible()
  await expect(workspace).toHaveCSS('width', '390px')
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)

  await openNavigation.click()
  const closeNavigation = sidebar.getByRole('button', { name: 'Close navigation' })
  await expect(sidebar).toBeVisible()
  await expect(closeNavigation).toBeFocused()
  await expect(page.getByRole('button', { name: 'Dismiss navigation' })).toBeVisible()

  await page.getByRole('button', { name: 'Dismiss navigation' }).click({ position: { x: 380, y: 350 } })
  await expect(sidebar).not.toBeInViewport()
  await expect(openNavigation).toBeFocused()

  await page.keyboard.press('Control+b')
  await expect(sidebar).toBeVisible()
  await expect(closeNavigation).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(sidebar).not.toBeInViewport()
  await expect(openNavigation).toBeFocused()

  await page.keyboard.press('Control+b')
  await sidebar.getByRole('button', { name: 'Open task: Polish task cards', exact: true }).click()
  await expect(sidebar).not.toBeInViewport()
  await expect(workspace.getByRole('heading', { name: 'Polish task cards' })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390)
})

test('mobile navigation has no project controls and preserves desktop sidebar persistence', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 })
  await page.goto(fixture)
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible()

  await page.setViewportSize({ width: 390, height: 700 })
  const openNavigation = page.getByRole('button', { name: 'Open navigation' })
  await openNavigation.click()
  const sidebar = page.locator('aside[aria-label="Task sidebar"]')
  await expect(sidebar.getByRole('button', { name: 'Project', exact: true })).toHaveCount(0)
  await expect(sidebar.getByRole('combobox', { name: 'Project', exact: true })).toHaveCount(0)
  await expect(sidebar.getByRole('button', { name: 'Open task: Layout test task', exact: true })).toBeVisible()
  await sidebar.getByRole('button', { name: 'Close navigation', exact: true }).click()
  await expect(sidebar).not.toBeInViewport()

  await page.setViewportSize({ width: 900, height: 700 })
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible()
})

test('task status icons and highlights remain visible when selected, hovered, and settled', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1100, height: 900 })
  await page.goto(fixture)
  const sidebar = page.getByRole('complementary')
  const merged = sidebar.getByRole('button', { name: 'Open task: Polish task cards', exact: true })
  const review = sidebar.getByRole('button', { name: 'Open task: Review sidebar changes', exact: true })
  const failed = sidebar.getByRole('button', { name: 'Open task: Retry provider setup', exact: true })
  await expect(merged.getByRole('img', { name: 'Merged', exact: true })).toHaveCSS('color', 'rgb(187, 154, 247)')
  await expect(review.getByRole('img', { name: 'Ready for review', exact: true })).toHaveClass(/text-orange-400/)
  await expect(failed.getByRole('img', { name: 'Failed', exact: true })).toHaveCSS('color', 'rgb(224, 108, 117)')
  await expect(merged.locator('..')).toHaveClass(/bg-violet\/8/)
  await expect(review.locator('..')).toHaveClass(/bg-orange-400\/8/)
  await merged.click()
  await merged.hover()
  await expect(merged.getByRole('img', { name: 'Merged', exact: true })).toBeVisible()
  await expect(merged.locator('..')).toHaveClass(/bg-violet\/8/)
  await expect(merged.locator('..')).toHaveClass(/outline-offset-1/)
  await page.screenshot({ path: testInfo.outputPath('sidebar-task-statuses.png') })
  await sidebar.getByRole('button', { name: 'Settle task: Polish task cards', exact: true }).click()
  const settled = sidebar.getByRole('region', { name: 'Settled tasks' })
  await settled.getByRole('button', { name: /^Settled/ }).click()
  const settledTask = settled.getByRole('button', { name: 'Open task: Polish task cards', exact: true })
  await expect(settledTask.getByRole('img', { name: 'Merged', exact: true })).toBeVisible()
  await expect(settledTask.locator('..')).toHaveClass(/bg-violet\/8/)
})

test('task updates replace the sidebar status without leaving stale success indicators', async ({ page }) => {
  await page.goto(fixture)
  const task = page.getByRole('button', { name: 'Open task: Build streaming support', exact: true })
  const scenarios = [
    { status: 'succeeded', deliveryStatus: 'reviewable', hasPullRequest: false, label: 'Ready for review' },
    { status: 'succeeded', deliveryStatus: 'reviewable', hasPullRequest: true, label: 'Open PR' },
    { status: 'succeeded', deliveryStatus: 'approved', hasPullRequest: true, label: 'Merged' },
    { status: 'running', deliveryStatus: 'approved', hasPullRequest: true, label: 'Working' },
    { status: 'failed', deliveryStatus: 'reviewable', hasPullRequest: true, label: 'Failed' },
    { status: 'succeeded', deliveryStatus: 'failed', hasPullRequest: false, label: 'Failed' },
    { status: 'cancelled', deliveryStatus: 'approved', hasPullRequest: false, label: null },
    { status: 'succeeded', deliveryStatus: 'no_changes', hasPullRequest: false, label: 'Ready for review' }
  ] as const
  await expect(task.getByRole('img', { name: 'Working', exact: true })).toBeVisible()
  for (const scenario of scenarios) {
    await page.evaluate(async ({ status, deliveryStatus, hasPullRequest }) => {
      const current = (await window.anvil.tasks.list()).find((task) => task.id === 'running')!
      window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: {
        ...current, status, deliveryStatus,
        pullRequest: hasPullRequest ? { number: 42, url: 'https://github.com/developer/anvil/pull/42' } : undefined
      } }))
    }, scenario)
    if (scenario.label) {
      await expect(task.getByRole('img', { name: scenario.label, exact: true })).toBeVisible()
      await expect(task.getByRole('img')).toHaveCount(1)
    } else {
      await expect(task.getByRole('img')).toHaveCount(0)
    }
    if (scenario.label === 'Open PR') {
      await expect(task.getByRole('img', { name: 'Open PR', exact: true }).locator('path')).toHaveAttribute('d', /M15 6C12\.6131/)
      await expect(task.locator('..')).toHaveClass(/bg-ok\/8/)
    } else if (scenario.label === 'Merged') {
      await expect(task.locator('..')).toHaveClass(/bg-violet\/8/)
    } else if (scenario.label !== 'Ready for review') {
      await expect(task.locator('..')).not.toHaveClass(/bg-(ok|orange-400|violet)\/8/)
    }
  }
  await task.click()
  await expect(task.getByRole('img', { name: 'Done', exact: true })).toBeVisible()
})

test('finished tasks of any style show a review state, sort first, and badge the header', async ({ page }) => {
  await page.goto(fixture)
  const sidebar = page.getByRole('complementary')
  const output = sidebar.getByRole('button', { name: 'Open task: Layout test task', exact: true })
  const badge = sidebar.getByRole('status', { name: /ready for review/ })

  await expect(badge).toHaveText('2')
  await expect(badge).toHaveAccessibleName('2 tasks ready for review')
  await expect(output.getByRole('img', { name: 'Ready for review', exact: true })).toBeVisible()

  const labels = await page.locator('nav[aria-label="Active tasks"] [data-task-id] button[aria-label^="Open task:"]')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label')))
  expect(labels.slice(0, 2)).toEqual(['Open task: Review sidebar changes', 'Open task: Layout test task'])

  await page.evaluate(async () => {
    const current = (await window.anvil.tasks.list()).find((task) => task.id === 'output')!
    window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...current, style: 'quick', checkoutMode: 'local' } }))
  })
  await expect(output.getByRole('img', { name: 'Ready for review', exact: true })).toBeVisible()

  await output.click()
  await expect(output.getByRole('img', { name: 'Done', exact: true })).toBeVisible()
  await expect(badge).toHaveText('1')

  await page.evaluate(async () => {
    const current = (await window.anvil.tasks.list()).find((task) => task.id === 'output')!
    window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...current, deliveryStatus: 'reviewable' } }))
  })
  await expect(output.getByRole('img', { name: 'Ready for review', exact: true })).toBeVisible()
  await expect(badge).toHaveText('2')
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

test('opening tasks across projects keeps the sidebar workspace-wide', async ({ page }) => {
  await page.goto(fixture)
  const sidebar = page.getByRole('complementary')
  await expect(sidebar.getByRole('combobox', { name: 'Project', exact: true })).toHaveCount(0)
  await expect(sidebar.getByRole('navigation', { name: 'Active tasks' }).getByRole('article')).toHaveCount(5)
  await sidebar.getByRole('button', { name: 'Open task: Polish task cards', exact: true }).click()
  await expect(page.getByRole('main').getByRole('heading', { name: 'Polish task cards', exact: true })).toBeVisible()
  await sidebar.getByRole('button', { name: 'Open task: Layout test task', exact: true }).click()
  await expect(page.getByRole('main').getByRole('heading', { name: 'Layout test task', exact: true })).toBeVisible()
  await expect(sidebar.getByRole('button', { name: 'Open task: Polish task cards', exact: true })).toBeVisible()
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

test('sidebar search stays workspace-wide and survives settings', async ({ page }) => {
  await page.goto(fixture)
  const sidebar = page.locator('aside[aria-label="Task sidebar"]')
  await expect(sidebar.getByRole('button', { name: 'Project', exact: true })).toHaveCount(0)
  await expect(sidebar.getByRole('combobox', { name: 'Project', exact: true })).toHaveCount(0)
  await expect(sidebar.getByRole('navigation', { name: 'Active tasks' }).getByRole('article')).toHaveCount(5)
  const search = sidebar.getByRole('searchbox', { name: 'Search tasks' })
  await search.fill('layout')
  await expect(sidebar.getByRole('button', { name: 'Open task: Layout test task', exact: true })).toBeVisible()
  await sidebar.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(sidebar).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button')).toHaveCount(7)
  await page.getByRole('button', { name: 'Back to workspace', exact: true }).click()
  await expect(search).toHaveValue('layout')
  await expect(sidebar.getByRole('navigation', { name: 'Active tasks' }).getByRole('article')).toHaveCount(1)
})

test('large project collections do not add controls or overflow to the sidebar', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 600, height: 700 })
  await page.goto(fixture + '?manyProjects')
  await page.getByRole('button', { name: 'Open navigation' }).click()
  const sidebar = page.locator('aside[aria-label="Task sidebar"]')
  await expect(sidebar.getByRole('button', { name: 'Project', exact: true })).toHaveCount(0)
  await expect(sidebar.getByRole('combobox', { name: 'Project', exact: true })).toHaveCount(0)
  await expect(sidebar.getByRole('button', { name: 'Open task: Layout test task', exact: true })).toBeVisible()
  expect(await sidebar.evaluate((element) => element.scrollWidth === element.clientWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('sidebar-workspace-wide.png') })
})
