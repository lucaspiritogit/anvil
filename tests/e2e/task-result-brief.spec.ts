import { expect, test, type Page } from '@playwright/test'

const fixture = '/tests/e2e/fixture/'
const brief = (page: Page) => page.getByRole('region', { name: 'Morning task results' })

test('greets with project-scoped results in newest-first order and opens review directly', async ({ page }, testInfo) => {
  await page.goto(`${fixture}?morningBrief`)
  const morning = brief(page)

  await expect(morning.getByRole('heading', { name: 'Good morning', exact: true })).toBeVisible()
  await expect(morning.getByText('Since you left… 3 task results are ready.', { exact: true })).toBeVisible()
  await expect(morning.locator('[data-notice-id]')).toHaveCount(3)
  await expect(morning.locator('[data-notice-id="notice-old-version"]')).toHaveCount(0)
  expect(await morning.locator('[data-notice-id] strong').allTextContents()).toEqual([
    'Review sidebar changes',
    'Clean up old logs',
    'Polish task cards'
  ])
  await expect(morning.getByText('Changes are ready for review')).toBeVisible()
  await expect(morning.getByText('1 minute ago')).toBeVisible()
  await expect(morning.getByText('Finished with no code changes')).toBeVisible()
  await expect(morning.getByText('Task completed')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('morning-brief-desktop.png') })

  await page.evaluate(() => window.composerTest.selectProject('project-1'))
  await expect(brief(page).getByText('Since you left… 1 task result is ready.', { exact: true })).toBeVisible()
  await expect(brief(page).getByText('Layout test task')).toBeVisible()
  await page.evaluate(() => window.composerTest.selectProject('project-0'))

  await brief(page).getByRole('button', { name: 'Review changes for: Review sidebar changes' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Review sidebar changes' })).toBeVisible()
  await expect(page.getByRole('tab', { name: /^Changes/ })).toHaveAttribute('aria-selected', 'true')
  await expect.poll(() => page.evaluate(() => window.morningBriefTest.calls)).toContainEqual({
    operation: 'seen', workspaceId: 'default', noticeId: 'notice-review'
  })

  await page.reload()
  await expect(brief(page).locator('[data-notice-id="notice-review"]')).toContainText('Seen')
})

test('acknowledges informational results, collapses after review, and re-expands for a later result', async ({ page }) => {
  await page.goto(`${fixture}?morningBrief`)
  const morning = brief(page)

  await page.evaluate(() => { window.morningBriefTest.failNext = true })
  await morning.getByRole('button', { name: 'Dismiss result for: Clean up old logs' }).click()
  await expect(morning.getByRole('alert')).toHaveText('Could not update the morning brief')
  await expect(morning.locator('[data-notice-id="notice-empty"]')).toBeVisible()

  await morning.getByRole('button', { name: 'Dismiss result for: Clean up old logs' }).click()
  await expect(morning.locator('[data-notice-id="notice-empty"]')).toHaveCount(0)
  await morning.getByRole('button', { name: 'Dismiss result for: Polish task cards' }).click()
  await expect(morning.getByText('Since you left… 1 task result is ready.', { exact: true })).toBeVisible()

  await page.evaluate(() => window.morningBriefTest.resolve('notice-review'))
  await expect(morning.getByText('Good morning. You’re all caught up.', { exact: true })).toBeVisible()
  await expect(morning.getByRole('button', { name: 'Expand' })).toHaveAttribute('aria-expanded', 'false')

  await morning.getByRole('button', { name: 'Expand' }).click()
  await expect(morning.getByText('Since you left… You’re all caught up.', { exact: true })).toBeVisible()
  await morning.getByRole('button', { name: 'Collapse' }).click()

  await page.evaluate(() => window.morningBriefTest.emit({
    id: 'notice-later', workspaceId: 'default', projectId: 'project-0', taskId: 'approved',
    resultVersion: 2, kind: 'completed', createdAt: Date.now()
  }))
  await expect(morning.getByRole('heading', { name: 'Good morning', exact: true })).toBeVisible()
  await expect(morning.getByText('Since you left… 1 task result is ready.', { exact: true })).toBeVisible()

  await morning.getByRole('button', { name: 'Dismiss result for: Polish task cards' }).click()
  await expect(morning.getByText('Good morning. You’re all caught up.', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => window.morningBriefTest.calls)).toEqual(expect.arrayContaining([
    { operation: 'seen', workspaceId: 'default', noticeId: 'notice-empty' },
    { operation: 'dismiss', workspaceId: 'default', noticeId: 'notice-empty' },
    { operation: 'seen', workspaceId: 'default', noticeId: 'notice-complete' },
    { operation: 'dismiss', workspaceId: 'default', noticeId: 'notice-complete' },
    { operation: 'seen', workspaceId: 'default', noticeId: 'notice-later' },
    { operation: 'dismiss', workspaceId: 'default', noticeId: 'notice-later' }
  ]))
})

test('keeps workspace feeds isolated and lets a missing task be acknowledged', async ({ page }) => {
  await page.goto(`${fixture}?morningBrief`)
  const otherWorkspaceId = await page.evaluate(async () => {
    await window.workspaceTest.create('Other')
    return (await window.anvil.workspaces.snapshot()).workspace.id
  })

  await expect(brief(page)).toHaveCount(0)
  await page.evaluate((workspaceId) => window.morningBriefTest.emit({
    id: 'notice-missing', workspaceId, projectId: 'project-0', taskId: 'deleted-task',
    resultVersion: 1, kind: 'completed', createdAt: Date.now()
  }), otherWorkspaceId)
  await expect(brief(page).getByText('Deleted task')).toBeVisible()
  await brief(page).getByRole('button', { name: 'Acknowledge result for deleted task' }).click()
  await expect(brief(page).getByText('Good morning. You’re all caught up.', { exact: true })).toBeVisible()

  await page.evaluate(() => window.workspaceTest.select('default'))
  await expect(brief(page).getByText('Since you left… 3 task results are ready.', { exact: true })).toBeVisible()
  await page.evaluate((workspaceId) => window.morningBriefTest.emit({
    id: 'notice-other-workspace', workspaceId, projectId: 'project-0', taskId: 'deleted-task',
    resultVersion: 2, kind: 'completed', createdAt: Date.now()
  }), otherWorkspaceId)
  await expect(brief(page).getByText('Since you left… 3 task results are ready.', { exact: true })).toBeVisible()
  await expect(brief(page).locator('[data-notice-id="notice-other-workspace"]')).toHaveCount(0)

  await page.evaluate(() => { window.morningBriefTest.delay = 150 })
  await brief(page).getByRole('button', { name: 'Dismiss result for: Clean up old logs' }).click()
  await page.evaluate((workspaceId) => window.workspaceTest.select(workspaceId), otherWorkspaceId)
  await expect(brief(page).getByText('Since you left… 1 task result is ready.', { exact: true })).toBeVisible()
  await expect(brief(page).getByText('Clean up old logs')).toHaveCount(0)
  await page.waitForTimeout(200)
  await expect(brief(page).locator('[data-notice-id="notice-other-workspace"]')).toBeVisible()
})

test('the compact and expanded brief keep the composer usable at a narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 600 })
  await page.goto(`${fixture}?morningBrief`)
  const overview = page.getByTestId('project-overview')
  const morning = brief(page)
  const composer = page.getByRole('form', { name: 'Start a task' })

  await expect(morning.getByRole('heading', { name: 'Good morning', exact: true })).toBeVisible()
  expect(await overview.evaluate((element) => element.scrollWidth)).toBeLessThanOrEqual(await overview.evaluate((element) => element.clientWidth))
  const overviewBox = (await overview.boundingBox())!
  const briefBox = (await morning.boundingBox())!
  expect(briefBox.x).toBeGreaterThanOrEqual(overviewBox.x)
  expect(briefBox.x + briefBox.width).toBeLessThanOrEqual(overviewBox.x + overviewBox.width)
  await composer.scrollIntoViewIfNeeded()
  await expect(composer.getByRole('textbox')).toBeVisible()
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeInViewport()
})
