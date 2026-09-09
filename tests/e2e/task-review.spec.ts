import { expect, test } from '@playwright/test'
import type { TaskIssueSnapshot } from '../../src/shared/types'

type ReviewCall = { kind: string; detail: Record<string, unknown> }

test('sub-task review pauses on the per-issue diff with approve and request-changes actions', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.evaluate(() => {
    const calls: ReviewCall[] = []
    Object.assign(window, { subtaskReviewCalls: calls })
    for (const kind of ['fixture:issue-diff', 'fixture:issue-approval', 'fixture:issue-rejection']) {
      window.addEventListener(kind, (event) => calls.push({ kind, detail: (event as CustomEvent<Record<string, unknown>>).detail }))
    }
  })
  const calls = (): Promise<ReviewCall[]> =>
    page.evaluate(() => (window as unknown as { subtaskReviewCalls: ReviewCall[] }).subtaskReviewCalls)
  const snapshot: TaskIssueSnapshot = {
    parent: { id: 'plan', anvilTaskId: 'review', title: 'Review sidebar changes', description: '' },
    children: [
      { id: 'issue-done', parentId: 'plan', title: 'Read the branch', description: '', status: 'complete', checklist: [], validation: '', labels: [], priority: 'medium', dependencies: [] },
      { id: 'issue-review', parentId: 'plan', title: 'Extract review actions', description: 'Split the review flow', status: 'review', checklist: [], validation: '', labels: [], priority: 'medium', dependencies: [] }
    ]
  }
  const publish = (value: TaskIssueSnapshot): Promise<void> =>
    page.evaluate((snapshot) => window.dispatchEvent(new CustomEvent('fixture:issues', { detail: { taskId: 'review', snapshot } })), value)
  await publish(snapshot)
  const sidebar = page.getByRole('complementary', { name: 'Task sidebar' })
  const subtask = sidebar.getByRole('button', { name: 'Open subtask: Extract review actions', exact: true })
  await sidebar.getByRole('button', { name: 'Expand subtasks: Review sidebar changes' }).click()
  // The sidebar and the parent run both surface the waiting-for-review state.
  await expect(subtask).toContainText('Review')
  await expect(page.getByRole('status', { name: 'Review gate' })).toBeVisible()
  await subtask.click()
  await expect(page.getByLabel('Valence status')).toHaveText('Review')
  await page.getByRole('tab', { name: 'Changes', exact: true }).click()
  const review = page.getByRole('region', { name: 'Subtask code changes' })
  await expect(review.getByRole('status')).toContainText('Waiting for your review')
  // The diff comes from the per-issue channel, not the whole task diff.
  await expect(review.getByRole('combobox', { name: 'Changed file' })).toHaveValue('src/sidebar.ts')
  await expect(review.locator('[data-line]').filter({ hasText: 'spacing: 12' })).toBeVisible()
  await expect.poll(calls).toContainEqual({ kind: 'fixture:issue-diff', detail: { taskId: 'review', issueId: 'issue-review' } })
  await review.locator('[data-column-number="2"][data-line-type="change-addition"]').click()
  await review.getByPlaceholder('Leave a note on this line…').fill('Rename this flag')
  await review.getByRole('button', { name: 'Add comment', exact: true }).click()
  await expect(review.getByText('1 line comment will be sent with the rework request.')).toBeVisible()
  await review.getByLabel('Rework feedback').fill('Also cover the empty case')
  await review.getByRole('button', { name: 'Request changes', exact: true }).click()
  await expect.poll(calls).toContainEqual({ kind: 'fixture:issue-rejection', detail: { taskId: 'review', comment: 'Also cover the empty case' } })
  // Rework restarts the issue; the next review submission refetches the diff.
  const rework = structuredClone(snapshot)
  rework.children[1].status = 'working'
  await publish(rework)
  await expect(page.getByLabel('Valence status')).toHaveText('Working')
  await expect(review.getByText('Its diff will appear here when the sub-task is submitted for review.')).toBeVisible()
  rework.children[1].status = 'review'
  await publish(rework)
  await expect(review.getByRole('combobox', { name: 'Changed file' })).toHaveValue('src/sidebar.ts')
  await review.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect.poll(calls).toContainEqual({ kind: 'fixture:issue-approval', detail: { taskId: 'review' } })
  await page.screenshot({ path: testInfo.outputPath('subtask-review.png') })
})

test('review shows Pierre beside the event stream, with file navigation and focus mode', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.getByRole('textbox', { name: 'Message to agent' }).fill('Keep this draft while reviewing')
  await page.getByRole('tab', { name: /^Changes/ }).click()
  const review = page.getByRole('region', { name: 'Code changes' })
  const output = page.getByRole('complementary', { name: 'Prompt and output' })
  const file = review.getByRole('combobox', { name: 'Changed file' })
  await expect(file).toHaveValue('src/sidebar.ts')
  await expect(review.locator('[data-diff-type="single"][data-overflow="wrap"]')).toBeVisible()
  await expect(review.locator('[data-line]').filter({ hasText: 'spacing: 12' })).toBeVisible()
  await expect(output.getByText('system', { exact: true })).toBeVisible()
  await expect(output.getByRole('form', { name: 'Steer task' })).toBeHidden()
  const reviewBounds = (await review.boundingBox())!
  const outputBounds = (await output.boundingBox())!
  expect(outputBounds.x).toBeGreaterThanOrEqual(reviewBounds.x + reviewBounds.width)
  await expect(review.getByRole('button', { name: 'Previous' })).toBeDisabled()
  await review.getByRole('checkbox', { name: 'Viewed' }).check()
  await expect(review.getByText('1 of 2 files viewed')).toBeVisible()
  await review.getByRole('button', { name: 'Next file' }).click()
  await expect(file).toHaveValue('README.md')
  await expect(review.getByRole('checkbox', { name: 'Viewed' })).not.toBeChecked()
  await expect(review.getByRole('button', { name: 'Next file' })).toBeDisabled()
  await file.selectOption('src/sidebar.ts')
  await expect(review.getByRole('checkbox', { name: 'Viewed' })).toBeChecked()
  await review.getByRole('button', { name: 'Focus diff' }).click()
  await expect(output).toBeHidden()
  expect((await review.boundingBox())!.width).toBeGreaterThan(reviewBounds.width)
  await review.getByRole('button', { name: 'Show output' }).click()
  await expect(output.getByRole('log', { name: 'Task output' })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('task-review.png') })
  await page.getByRole('tab', { name: 'Output' }).click()
  await expect(output.getByRole('textbox')).toHaveValue('Keep this draft while reviewing')
  expect(errors).toEqual([])
})

test('Pierre line comments and approval remain available', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.getByRole('tab', { name: /^Changes/ }).click()
  const review = page.getByRole('region', { name: 'Code changes' })
  await review.locator('[data-column-number="2"][data-line-type="change-addition"]').click()
  await review.getByPlaceholder('Leave a note on this line…').fill('Keep this spacing consistent')
  await review.getByRole('button', { name: 'Add comment', exact: true }).click()
  await expect(review.getByText('Keep this spacing consistent', { exact: true })).toBeVisible()
  await expect(review.getByRole('button', { name: 'Send comments' })).toBeEnabled()
  await review.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(review.getByText('Keep this spacing consistent', { exact: true })).toHaveCount(0)
  await expect(review.getByRole('button', { name: 'Send comments' })).toBeDisabled()
  await review.locator('summary').click()
  await expect(review.getByRole('button', { name: 'Rebase', exact: true })).toBeEnabled()
  await expect(review.getByText('Update sidebar spacing')).toBeVisible()
  await review.getByRole('button', { name: 'Approve', exact: true }).click()
  const confirmation = page.getByRole('alertdialog', { name: 'Merge and approve?' })
  await expect(confirmation).toContainText('anvil/review')
  await expect(confirmation).toContainText('user-current')
  await expect(confirmation).toContainText('3 commits will be brought in')
  await page.screenshot({ path: testInfo.outputPath('merge-confirmation.png') })
  await confirmation.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirmation).toBeHidden()
  await expect(review.getByRole('button', { name: 'Approve', exact: true })).toBeFocused()
  await review.getByRole('button', { name: 'Approve', exact: true }).click()
  await confirmation.getByRole('button', { name: 'Merge and approve', exact: true }).click()
  await expect(confirmation.getByRole('button', { name: 'Merging…' })).toBeDisabled()
  await expect(confirmation).toBeHidden()
  await expect(review.getByRole('button', { name: 'Approved', exact: true })).toBeDisabled()
})

test('merge errors stay in the confirmation without approving the task', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=review&mergeFailure=1')
  await page.getByRole('tab', { name: /^Changes/ }).click()
  const approve = page.getByRole('button', { name: 'Approve', exact: true })
  await approve.click()
  const confirmation = page.getByRole('alertdialog')
  await confirmation.getByRole('button', { name: 'Merge and approve', exact: true }).click()
  await expect(confirmation.getByRole('button', { name: 'Cancel' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(confirmation).toBeVisible()
  await expect(confirmation.getByRole('alert')).toHaveText('Merge failed. The task was not approved.')
  await page.keyboard.press('Escape')
  await expect(confirmation).toBeHidden()
  await expect(approve).toBeEnabled()
  await expect(approve).toBeFocused()
})

test('preview failures disable approval', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=review&mergePreviewFailure=1')
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  const confirmation = page.getByRole('alertdialog')
  await expect(confirmation.getByRole('alert')).toHaveText('Check out a branch before approving')
  await expect(confirmation.getByRole('button', { name: 'Merge and approve', exact: true })).toBeDisabled()
  await confirmation.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirmation).toBeHidden()
})

for (const commitCount of [0, 1]) {
  test(`merge confirmation handles ${commitCount} incoming commits`, async ({ page }) => {
    await page.goto(`/tests/e2e/fixture/?scenario=review&mergeCommitCount=${commitCount}`)
    await page.getByRole('tab', { name: /^Changes/ }).click()
    await page.getByRole('button', { name: 'Approve', exact: true }).click()
    const confirmation = page.getByRole('alertdialog')
    await expect(confirmation).toContainText(`${commitCount} commit${commitCount === 1 ? '' : 's'} will be brought in`)
    if (!commitCount) await expect(confirmation).toContainText('already merged')
    await expect(confirmation.getByRole('button', { name: 'Merge and approve', exact: true })).toBeEnabled()
  })
}

test('narrow review switches panels without losing file or steering drafts', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 500 })
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.getByRole('tab', { name: /^Changes/ }).click()
  const file = page.getByRole('combobox', { name: 'Changed file' })
  await file.selectOption('README.md')
  await expect(page.getByRole('button', { name: 'Next file' })).toBeInViewport({ ratio: 1 })
  await page.getByRole('tab', { name: 'Output' }).click()
  await expect(file).toBeHidden()
  const input = page.getByRole('textbox', { name: 'Message to agent' })
  await input.fill('Preserve this follow-up')
  await page.getByRole('tab', { name: 'Changes' }).click()
  await expect(file).toHaveValue('README.md')
  await page.getByRole('tab', { name: 'Output' }).click()
  await expect(input).toHaveValue('Preserve this follow-up')
})

test('copies the exact branch name and task ID', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/tests/e2e/fixture/?scenario=review')
  for (const [label, value] of [['branch name', 'anvil/review'], ['task ID', 'review']]) {
    await expect(page.getByRole('main').locator('code').filter({ hasText: new RegExp(`^${value}$`) })).toBeVisible()
    await page.getByRole('button', { name: `Copy ${label}`, exact: true }).click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(value)
    await expect(page.getByRole('status').filter({ hasText: `Copied ${label}` })).toBeVisible()
  }
})

test('clipboard failure gives feedback without replacing the task', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'writeText', { value: async () => { throw new Error('Denied') } })
  })
  await page.getByRole('button', { name: 'Copy task ID', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Could not copy task ID' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Review sidebar changes', exact: true })).toBeVisible()
})

test('failed diff loads can be retried and an empty patch stays readable', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=review&diffFailure=1')
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await expect(page.getByRole('alert')).toHaveText(/Could not load the task diff/)
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByRole('combobox', { name: 'Changed file' })).toBeVisible()
  await page.goto('/tests/e2e/fixture/?scenario=review&emptyDiff=1')
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await expect(page.getByText('No file changes in this range.')).toBeVisible()
  await expect(page.getByRole('form', { name: 'Steer task' })).toBeHidden()
  await page.getByRole('tab', { name: 'Output' }).click()
  await expect(page.getByRole('form', { name: 'Steer task' })).toBeVisible()
})
