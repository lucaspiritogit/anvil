import { expect, test, type Page } from '@playwright/test'
import type { TaskIssueSnapshot } from '../../src/shared/types'

function snapshot(owner: string): TaskIssueSnapshot {
  return {
    parent: { id: owner, title: owner, description: '' },
    children: (['queued', 'working', 'blocked', 'complete'] as const).map((status, index) => ({
      id: `${owner}-${index}`, parentId: owner, title: `${owner} ${status}`, status,
      description: '', checklist: [], validation: '', labels: [], priority: 'medium', dependencies: []
    }))
  }
}

const STATUS_LABEL = { queued: 'Queued', working: 'Working', blocked: 'Blocked', review: 'Review', complete: 'Done' } as const
async function publish(page: Page, taskId: string, value: TaskIssueSnapshot) {
  await page.evaluate(({ taskId, value }) => window.dispatchEvent(new CustomEvent('fixture:issues', {
    detail: { taskId, snapshot: value }
  })), { taskId, value })
}

for (const width of [1440, 900]) {
  test(`sidebar shows informational compact children at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 900 ? 500 : 900 })
    await page.goto('/tests/e2e/fixture/')
    const sidebar = page.getByRole('complementary', { name: 'Task sidebar' })
    const children = sidebar.getByRole('list', { name: 'Subtasks of Build streaming support' })
    const value = snapshot('stream')
    value.children[3].title = 'A completed child with a title that is too long to fit within the sidebar row'
    await publish(page, 'running', value)
    await publish(page, 'output', snapshot('layout'))
    const disclosure = sidebar.getByRole('button', { name: 'Expand subtasks: Build streaming support', exact: true })
    await disclosure.hover()
    await expect(disclosure).toHaveClass(/hover:bg-white\/5/)
    await expect(disclosure).not.toHaveClass(/hover:bg-hover/)
    await expect(disclosure).toHaveCSS('background-color', /\/ 0\.05\)$/)
    await disclosure.click()
    await sidebar.getByRole('button', { name: 'Expand subtasks: Layout test task', exact: true }).click()
    await expect(children.getByRole('listitem')).toHaveCount(4)
    await expect(sidebar.getByRole('list', { name: 'Subtasks of Layout test task' }).getByRole('listitem')).toHaveCount(4)
    await expect(page.getByRole('tabpanel', { name: 'Issues' })).toHaveCount(0)
    await expect(children.getByRole('listitem')).toHaveText(value.children.map((issue) => `${issue.title}${STATUS_LABEL[issue.status]}`))
    const parent = sidebar.getByRole('button', { name: 'Open task: Build streaming support', exact: true })
    const child = children.getByRole('listitem').first()
    const parentBox = (await parent.boundingBox())!
    const childBox = (await child.boundingBox())!
    expect(childBox.height).toBeGreaterThanOrEqual(28)
    expect(childBox.height).toBeLessThan(parentBox.height)
    expect(childBox.width).toBeLessThan(parentBox.width)
    expect(childBox.x).toBeGreaterThan(parentBox.x)
    await parent.click()
    await expect(children.locator('button, a, [tabindex], [aria-current], [role="button"], [role="link"]')).toHaveCount(0)
    await child.click()
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Build streaming support')
    await expect(parent).toHaveAttribute('aria-current', 'page')
    await parent.focus()
    await parent.press('Tab')
    await expect(sidebar.getByRole('button', { name: 'Collapse subtasks: Build streaming support', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    expect(await children.evaluate((list) => list.contains(document.activeElement))).toBe(false)
    await parent.focus()
    await child.evaluate((row: HTMLElement) => row.focus())
    await expect(parent).toBeFocused()
    await page.keyboard.press('Space')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Build streaming support')
    await page.screenshot({ path: testInfo.outputPath(`sidebar-subtasks-${width}.png`) })
    await testInfo.attach('Row dimensions', { body: JSON.stringify({ parentBox, childBox }), contentType: 'application/json' })
    await child.click({ button: 'right' })
    await expect(page.getByRole('menu')).toHaveCount(0)
    value.children[0].status = 'working'
    value.children.push({ ...value.children[0], id: 'new-child', title: 'Discovered live' })
    await publish(page, 'running', value)
    await expect(children.getByRole('listitem').first()).toContainText(STATUS_LABEL.working)
    await expect(children.getByRole('listitem')).toHaveCount(5)
    await expect(children.getByRole('listitem').last()).toContainText('Discovered live')
    const archived = snapshot('archived')
    archived.children[3].title = value.children[3].title
    await publish(page, 'settled', archived)
    await sidebar.getByRole('searchbox').fill('Clean up old logs')
    const settledParent = sidebar.getByRole('button', { name: 'Open task: Clean up old logs', exact: true })
    await settledParent.click()
    const settledRows = sidebar.getByRole('list', { name: 'Subtasks of Clean up old logs' })
    await settledRows.getByRole('listitem').first().click()
    await expect(settledParent).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Clean up old logs')
    await expect(settledRows.locator('button, a, [tabindex], [aria-current]')).toHaveCount(0)
    await page.screenshot({ path: testInfo.outputPath(`sidebar-settled-${width}.png`) })

  })
}

test('children survive filters, search, cached read errors and settlement; deletion removes the group', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/')
  const sidebar = page.getByRole('complementary')
  const search = sidebar.getByRole('searchbox')
  const parent = sidebar.getByRole('button', { name: 'Open task: Polish task cards', exact: true })
  const children = sidebar.getByRole('list', { name: 'Subtasks of Polish task cards' })
  await search.fill('needle')
  const value = snapshot('polish')
  value.children[0].title = 'needle child'
  await publish(page, 'approved', value)
  await expect(parent).toBeVisible()
  await sidebar.getByRole('button', { name: 'Expand subtasks: Polish task cards', exact: true }).click()
  await expect(children.getByRole('listitem')).toHaveCount(4)
  await expect(sidebar.getByRole('article')).toHaveCount(1)
  const selector = sidebar.getByRole('combobox', { name: 'Project', exact: true })
  await selector.click()
  await sidebar.getByRole('option').filter({ hasText: '/tmp/workbench' }).click()
  await expect(parent).toHaveCount(0)
  await selector.click()
  await sidebar.getByRole('option', { name: 'All Tasks from all projects', exact: true }).click()
  await expect(children).toBeVisible()
  await page.evaluate(() => { window.anvil.tasks.issues = async () => { throw new Error('Read unavailable') } })
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await parent.click()
  await parent.hover()
  await sidebar.getByRole('button', { name: 'Settle task: Polish task cards', exact: true }).click()
  const settled = sidebar.getByRole('region', { name: 'Settled tasks' })
  await expect(settled.getByRole('list', { name: 'Subtasks of Polish task cards' })).toBeVisible()
  await expect(settled.getByRole('button', { name: /^Settled/ })).toHaveText('Settled1')
  await expect(children.getByRole('listitem')).toHaveCount(4)
  await parent.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await page.getByRole('dialog', { name: 'Delete task?' }).getByRole('button', { name: 'Delete task', exact: true }).click()
  await expect(parent).toHaveCount(0)
  await expect(children).toHaveCount(0)
})

test('collapsed settled owners discover children before searching or expanding', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/')
  const value = snapshot('archived')
  await publish(page, 'settled', value)
  await page.getByRole('searchbox').fill('archived queued')
  const sidebar = page.getByRole('complementary')
  await expect(sidebar.getByRole('button', { name: 'Open task: Clean up old logs', exact: true })).toBeVisible()
  await expect(sidebar.getByRole('list', { name: 'Subtasks of Clean up old logs' }).getByRole('listitem')).toHaveCount(4)
})
