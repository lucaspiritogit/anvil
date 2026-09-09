import { expect, test, type Page } from '@playwright/test'
import type { TaskIssueSnapshot } from '../../src/shared/types'

const snapshot: TaskIssueSnapshot = {
  parent: { id: 'parent', title: 'Plan the task', description: 'Parent summary' },
  children: (['queued', 'working', 'blocked', 'complete'] as const).map((status, index) => ({
    id: `child-${index}`, parentId: 'parent', title: `Issue ${index}`, description: index ? '' : 'First summary',
    status, checklist: [], validation: '', labels: [], priority: 'medium', dependencies: []
  }))
}
async function publish(page: Page, value: TaskIssueSnapshot | null) {
  await page.evaluate((value) => window.dispatchEvent(new CustomEvent('fixture:issues', {
    detail: { taskId: 'output', snapshot: value }
  })), value)
}
for (const viewport of [{ width: 1440, height: 900 }, { width: 900, height: 500 }]) {
  test(`issue cards, keyboard, live details and tab regressions at ${viewport.width}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    await page.goto('/tests/e2e/fixture/?scenario=output&steering')
    await publish(page, snapshot)
    await page.getByRole('tab', { name: 'Issues', exact: true }).click()
    const panel = page.getByRole('tabpanel', { name: 'Issues' })
    await expect(panel).toBeVisible()
    await expect(page.getByRole('log')).toBeHidden()
    await expect(page.getByRole('region', { name: 'Code changes' })).toBeHidden()
    await expect(page.getByRole('textbox')).toBeHidden()
    await expect(panel.getByRole('region', { name: 'Parent issue', exact: true }).getByRole('button')).toHaveCount(1)
    await expect(panel.getByRole('region', { name: 'Child issues' }).getByRole('listitem')).toHaveCount(4)
    for (const status of ['Queued', 'Working', 'Blocked', 'Complete']) await expect(panel.getByText(status, { exact: true })).toBeVisible()
    const parent = panel.getByRole('button', { name: /Plan the task/ })
    await parent.focus()
    await page.keyboard.press('Enter')
    await expect(parent).toHaveAttribute('aria-expanded', 'true')
    await expect(panel.getByText('Parent summary')).toBeVisible()
    await page.keyboard.press('Space')
    await expect(parent).toHaveAttribute('aria-expanded', 'false')
    await panel.getByRole('button', { name: /Issue 0/ }).click()
    await expect(panel.getByText('First summary')).toBeVisible()
    const updated = structuredClone(snapshot)
    updated.children[0].status = 'complete'
    updated.children[0].description = 'Updated summary'
    await publish(page, updated)
    await expect(panel.getByText('Updated summary')).toBeVisible({ timeout: 1000 })
    await expect(panel.getByRole('button', { name: 'Issue 0 Complete', exact: true })).toHaveAttribute('aria-expanded', 'true')
    await page.screenshot({ path: testInfo.outputPath('issues.png') })
    await panel.getByRole('button', { name: /Issue 1/ }).click()
    await expect(panel.getByText('No description provided.').filter({ visible: true })).toHaveCount(1)
    await page.getByRole('tab', { name: /^Changes/ }).click()
    await expect(page.getByRole('region', { name: 'Code changes' })).toBeVisible()
    await page.getByRole('tab', { name: 'Output', exact: true }).click()
    await expect(page.getByRole('log')).toBeVisible()
    await page.getByRole('tab', { name: 'Issues', exact: true }).click()
    await expect(panel.getByRole('button', { name: /Issue 1/ })).toHaveAttribute('aria-expanded', 'true')
    updated.parent.title = 'Long title '.repeat(80)
    updated.children[0].description = 'Long description\n'.repeat(100)
    await publish(page, updated)
    await panel.getByRole('button', { name: /Issue 0/ }).click()
    await expect(panel.getByText(updated.children[0].description)).toBeVisible()
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
    await panel.evaluate((el) => { el.scrollTop = el.scrollHeight })
    await page.screenshot({ path: testInfo.outputPath('issues-scrolled.png') })
    const sidebar = page.getByRole('complementary', { name: 'Task sidebar' })
    await sidebar.getByRole('combobox', { name: 'Project', exact: true }).click()
    await sidebar.getByRole('option').filter({ hasText: '/tmp/workbench' }).click()
    await expect(page.getByRole('form', { name: 'Start a task' })).toBeVisible()
  })
}

test('loading, errors, retry, stale data, empty states and task switching', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output')
  await page.evaluate(() => {
    const read = window.anvil.tasks.issues
    window.anvil.tasks.issues = async (id) => {
      while (document.body.dataset.issueWait === 'true') await new Promise((resolve) => setTimeout(resolve, 20))
      if (document.body.dataset.issueError === 'true') throw new Error('Storage unavailable')
      return read(id)
    }
    document.body.dataset.issueWait = 'true'
  })
  await page.getByRole('tab', { name: 'Issues', exact: true }).click()
  await expect(page.getByText('Loading issues…')).toBeVisible()
  await page.evaluate(() => { document.body.dataset.issueError = 'true'; document.body.dataset.issueWait = 'false' })
  await expect(page.getByRole('alert')).toContainText('Could not load issues.')
  await page.evaluate(() => { document.body.dataset.issueError = 'false' })
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByText('No execution metadata is available for this task.')).toBeVisible()
  await publish(page, { ...snapshot, children: [] })
  await expect(page.getByText('No child issues yet.')).toBeVisible()
  await page.getByRole('button', { name: /Plan the task/ }).click()
  await publish(page, { ...snapshot, parent: { ...snapshot.parent, description: 'Updated parent' } })
  await expect(page.getByText('Updated parent')).toBeVisible({ timeout: 1000 })
  await page.evaluate(() => { document.body.dataset.issueError = 'true' })
  await expect(page.getByRole('alert')).toContainText('Showing last known data.')
  await expect(page.getByText('Updated parent')).toBeVisible()
  const sidebar = page.getByRole('complementary', { name: 'Task sidebar' })
  await sidebar.getByRole('combobox', { name: 'Project', exact: true }).click()
  await sidebar.getByRole('option').filter({ hasText: '/tmp/anvil' }).click()
  await page.getByRole('button', { name: /Build streaming support/ }).click()
  await expect(page.getByRole('tab', { name: 'Output', exact: true })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('tab', { name: 'Issues', exact: true }).click()
  await expect(page.getByText('Updated parent')).toHaveCount(0)
})
