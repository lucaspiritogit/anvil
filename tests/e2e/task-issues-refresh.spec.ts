import { expect, test } from '@playwright/test'

test('collapsed owner surfaces every issue transition without becoming final-deliverable', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/')
  await page.evaluate(async () => {
    const task = (await window.anvil.tasks.list()).find((task) => task.id === 'output')!
    window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...task, status: 'running', deliveryStatus: 'working' } }))
  })
  const parent = page.getByRole('button', { name: 'Open task: Layout test task', exact: true })
  await parent.click()
  for (const status of ['queued', 'working', 'review', 'queued', 'working', 'blocked', 'working', 'review', 'complete'] as const) {
    await page.evaluate((status) => window.dispatchEvent(new CustomEvent('fixture:issues', { detail: {
      taskId: 'output', snapshot: {
        parent: { id: 'plan', title: 'Plan', description: '' },
        children: [{ id: 'child', title: 'Implement navigation', description: '', status }],
        execution: { phase: status === 'review' ? 'reviewing' : status === 'blocked' ? 'blocked' : 'working', currentIssueId: 'child', error: null },
        reviewReady: false
      }
    } })), status)
    const label = { queued: 'Queued', working: 'Working', review: 'Saving changes…', blocked: 'Blocked', complete: 'Done' }[status]
    await expect(parent).toContainText(`${label}: Implement navigation`)
    await expect(page.getByLabel('Task status', { exact: true })).toHaveText(`${label}: Implement navigation`)
    await expect(page.getByRole('list', { name: 'Subtasks of Layout test task' })).toHaveCount(0)
    if (status === 'review') await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled()
    else await expect(page.getByRole('button', { name: 'Approve', exact: true })).toHaveCount(0)
    if (status === 'review') {
      await expect(page.getByLabel('Agent activity')).toContainText('Saving changes…')
      await expect(parent.getByRole('img', { name: 'Working', exact: true })).toHaveCount(0)
      await page.screenshot({ path: testInfo.outputPath('parent-stopping.png') })
      await page.evaluate(async () => {
        const snapshot = await window.anvil.tasks.issues('output')
        window.dispatchEvent(new CustomEvent('fixture:issues', { detail: { taskId: 'output', snapshot: { ...snapshot, reviewReady: true } } }))
      })
      await expect(page.getByLabel('Review gate')).toContainText('Waiting for your review')
    }
    await page.screenshot({ path: testInfo.outputPath(`parent-${status}.png`) })
  }
  await page.setViewportSize({ width: 900, height: 720 })
  await expect(page.getByLabel('Task status', { exact: true })).toContainText('Done')
  await page.screenshot({ path: testInfo.outputPath('parent-narrow.png') })
})

test('hook follows external snapshots only while enabled, including completed tasks', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?issuesRefresh')
  const state = page.getByLabel('Issue snapshot')
  await page.evaluate(() => {
    const original = window.anvil.tasks.issues
    let reads = 0
    window.anvil.tasks.issues = async (id) => {
      document.body.dataset.issueReads = String(++reads)
      return original(id)
    }
  })
  await expect(state).toContainText('"loading":false')
  expect(await page.locator('body').getAttribute('data-issue-reads')).toBeNull()
  await page.getByText('Toggle issues', { exact: true }).click()
  await expect(state).toContainText('"missing":true')
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture:issues', { detail: {
    taskId: 'output', snapshot: {
      parent: { id: 'parent', title: 'External parent', description: '' },
      children: [{ id: 'child', title: 'External child', description: 'Fresh summary', status: 'working' }]
    }
  } })))
  await expect(state).toContainText('"status":"working"', { timeout: 1000 })
  await expect(state).toContainText('"selectedIssue":{"id":"child"')
  await page.getByText('Switch task', { exact: true }).click()
  await expect(state).toContainText('"taskId":"approved"')
  await expect(state).not.toContainText('Fresh summary')
  await page.getByText('Toggle issues', { exact: true }).click()
  const stopped = await page.locator('body').getAttribute('data-issue-reads')
  await page.waitForTimeout(1100)
  expect(await page.locator('body').getAttribute('data-issue-reads')).toBe(stopped)
  await page.getByText('Toggle issues', { exact: true }).click()
  await expect.poll(() => page.locator('body').getAttribute('data-issue-reads')).not.toBe(stopped)
  await page.getByText('Delete task', { exact: true }).click()
  const deleted = await page.locator('body').getAttribute('data-issue-reads')
  await page.waitForTimeout(1100)
  expect(await page.locator('body').getAttribute('data-issue-reads')).toBe(deleted)
})

test('sidebar discovers issues before the panel opens and the panel reuses its snapshot', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/')
  await page.evaluate(() => {
    const original = window.anvil.tasks.issues
    window.anvil.tasks.issues = async (id) => {
      const result = await original(id)
      if (id === 'output' && result?.children.length) document.body.dataset.discoveredChild = result.children[0].id
      return result
    }
    window.dispatchEvent(new CustomEvent('fixture:issues', { detail: {
      taskId: 'output', snapshot: {
        parent: { id: 'parent', title: 'Planning parent', description: '' },
        children: [{ id: 'planning-child', title: 'Created during planning', description: '', status: 'queued' }]
      }
    } }))
  })
  await expect(page.locator('body')).toHaveAttribute('data-discovered-child', 'planning-child')
  await page.getByRole('button', { name: 'Open task: Layout test task', exact: true }).click()
  // Existing cached data remains available even when subsequent refreshes fail.
  await page.evaluate(() => { window.anvil.tasks.issues = async () => { throw new Error('Offline') } })
  await page.getByRole('tab', { name: 'Issues', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Created during planning', exact: true })).toBeVisible()
  await expect(page.getByRole('alert')).toContainText('Showing last known data.')
})
