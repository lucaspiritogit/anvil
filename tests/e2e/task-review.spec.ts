import { expect, test } from '@playwright/test'
import type { TaskIssueSnapshot } from '../../src/shared/types'

type ReviewCall = { kind: string; detail: Record<string, unknown> }

test('owner reviews two isolated ranges and rework before the combined final diff', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.evaluate(async () => {
    const task = (await window.anvil.tasks.list()).find((task) => task.id === 'review')!
    window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...task, status: 'running', deliveryStatus: 'working' } }))
  })
  await expect(page.getByRole('log')).toContainText('The sidebar spacing is updated')
  await page.evaluate(() => {
    const snapshot: TaskIssueSnapshot = {
      parent: { id: 'plan', title: 'Two changes', description: '' },
      execution: { phase: 'reviewing', currentIssueId: 'first', error: null },
      reviewReady: true,
      children: ['first', 'second'].map((id) => ({ id, parentId: 'plan', title: `${id} change`, description: '',
        status: id === 'first' ? 'review' : 'queued', baseCommit: `base-${id}`, headCommit: `head-${id}`,
        checklist: [], validation: '', labels: [], priority: 'medium', dependencies: [] }))
    }
    const publish = () => window.dispatchEvent(new CustomEvent('fixture:issues', { detail: { taskId: 'review', snapshot: structuredClone(snapshot) } }))
    const patch = (id: string) => `diff --git a/${id}.txt b/${id}.txt\nnew file mode 100644\n--- /dev/null\n+++ b/${id}.txt\n@@ -0,0 +1 @@\n+${id} change\n`
    window.anvil.tasks.issueDiff = async ({ issueId }) => ({ patch: patch(issueId), commits: [] })
    window.anvil.tasks.diff = async () => ({ patch: patch('first') + patch('second'), commits: [] })
    window.anvil.tasks.approveIssue = async ({ issueId }) => {
      snapshot.children.find((child) => child.id === issueId)!.status = 'complete'
      if (issueId === 'first') {
        snapshot.children[1].status = 'review'
        snapshot.execution!.currentIssueId = 'second'
      } else {
        snapshot.execution = { phase: 'complete', currentIssueId: null, error: null }
        const task = (await window.anvil.tasks.list()).find((task) => task.id === 'review')!
        window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...task, status: 'succeeded', deliveryStatus: 'reviewable' } }))
      }
      publish()
      return (await window.anvil.tasks.list()).find((task) => task.id === 'review')!
    }
    window.anvil.tasks.rejectIssue = async ({ issueId, comment }) => {
      if (issueId !== 'second' || comment !== 'Rework second only') throw new Error('Wrong review feedback')
      snapshot.children[1].status = 'working'
      snapshot.execution!.phase = 'working'
      publish()
      setTimeout(() => {
        snapshot.children[1].status = 'review'
        snapshot.children[1].headCommit = 'reworked-second'
        snapshot.execution!.phase = 'reviewing'
        publish()
      }, 1200)
      return (await window.anvil.tasks.list()).find((task) => task.id === 'review')!
    }
    publish()
    for (const [index, text] of ['Planning history', 'First issue output', 'Second issue output'].entries()) {
      window.dispatchEvent(new CustomEvent('fixture:output', { detail: { id: `history-${index}`, taskId: 'review',
        issueId: index ? ['first', 'second'][index - 1] : undefined, ts: Date.now(), stream: 'stdout', kind: 'output', category: 'message', text } }))
    }
  })
  await expect(page.getByLabel('Task status', { exact: true })).toContainText('first change')
  await page.getByRole('tab', { name: /^Changes/ }).click()
  const file = page.getByRole('combobox', { name: 'Changed file' })
  await expect(file).toHaveValue('first.txt')
  await page.getByLabel('Rework feedback').fill('Do not carry this draft')
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(file).toHaveValue('second.txt')
  await expect(file.locator('option')).toHaveCount(1)
  await expect(page.getByLabel('Rework feedback')).toHaveValue('')
  await page.getByLabel('Rework feedback').fill('Rework second only')
  await page.getByRole('button', { name: 'Request changes', exact: true }).click()
  await expect(page.getByLabel('Rework feedback')).toBeHidden()
  await expect(page.getByLabel('Rework feedback')).toHaveValue('')
  await expect(file).toHaveValue('second.txt')
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('button', { name: 'Expand subtasks: Review sidebar changes', exact: true }).click()
  const rows = page.getByRole('list', { name: 'Subtasks of Review sidebar changes' })
  await expect(rows.locator('button, a, [tabindex], [aria-current]')).toHaveCount(0)
  await rows.getByRole('listitem').first().click()
  await expect(file).toHaveValue('second.txt')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Review sidebar changes')
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: testInfo.outputPath('second-review-wide.png') })
  await page.setViewportSize({ width: 900, height: 650 })
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('button', { name: 'Request changes', exact: true })).toBeInViewport({ ratio: 1 })
  await expect(page.getByLabel('Rework feedback')).toBeInViewport({ ratio: 1 })
  await page.screenshot({ path: testInfo.outputPath('second-review-narrow.png') })
  await page.getByRole('tab', { name: 'Output', exact: true }).click()
  for (const text of ['Planning history', 'First issue output', 'Second issue output']) await expect(page.getByRole('log')).toContainText(text)
  await page.screenshot({ path: testInfo.outputPath('continuous-output.png') })
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Open PR', exact: true })).toBeVisible()
  await expect(file.locator('option')).toHaveCount(2)
  await expect(file.locator('option')).toHaveText(['first.txt', 'second.txt'])
  await page.screenshot({ path: testInfo.outputPath('combined-final-review.png') })
})

test('owner handles failed and empty issue diffs with explicit legacy fallback', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.evaluate(async () => {
    const task = (await window.anvil.tasks.list()).find((task) => task.id === 'review')!
    window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...task, status: 'running', deliveryStatus: 'working' } }))
  })
  await page.evaluate(() => {
    let attempt = 0
    window.anvil.tasks.issueDiff = async () => {
      if (++attempt === 1) throw new Error('Recorded range unavailable')
      return { patch: '', commits: [] }
    }
    window.dispatchEvent(new CustomEvent('fixture:issues', { detail: { taskId: 'review', snapshot: {
      parent: { id: 'plan', title: 'Plan', description: '' }, reviewReady: true,
      children: [{ id: 'empty', parentId: 'plan', title: 'No changes', description: '', status: 'review', checklist: [], validation: '', labels: [], priority: 'medium', dependencies: [] }]
    } } }))
  })
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await expect(page.getByRole('alert')).toContainText('Recorded range unavailable')
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await expect(page.getByText('No file changes in this range.')).toBeVisible()
  await expect(page.getByText(/Legacy submission:/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled()
})

test('a late sibling diff cannot replace the current review', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.evaluate(async () => {
    const task = (await window.anvil.tasks.list()).find((task) => task.id === 'review')!
    window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...task, status: 'running', deliveryStatus: 'working' } }))
  })
  await expect(page.getByRole('log')).toContainText('The sidebar spacing is updated')
  await page.evaluate(() => {
    const snapshot: TaskIssueSnapshot = {
      parent: { id: 'plan', title: 'Plan', description: '' },
      children: ['slow', 'next'].map((id) => ({ id, parentId: 'plan', title: id, description: '',
        status: id === 'slow' ? 'review' : 'queued', checklist: [], validation: '', labels: [], priority: 'medium', dependencies: [] }))
    }
    const publish = () => window.dispatchEvent(new CustomEvent('fixture:issues', { detail: { taskId: 'review', snapshot: structuredClone(snapshot) } }))
    window.anvil.tasks.issueDiff = async ({ issueId }) => {
      if (issueId === 'slow') {
        setTimeout(() => {
          snapshot.children[0].status = 'complete'
          snapshot.children[1].status = 'review'
          publish()
        }, 50)
        await new Promise((resolve) => setTimeout(resolve, 1800))
        window.dispatchEvent(new Event('fixture:slow-diff-returned'))
        return { patch: 'stale sibling patch', commits: [] }
      }
      return { patch: '', commits: [] }
    }
    Object.assign(window, { slowDiffReturned: false })
    window.addEventListener('fixture:slow-diff-returned', () => Object.assign(window, { slowDiffReturned: true }))
    publish()
  })
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await expect(page.getByLabel('Task status', { exact: true })).toContainText('next')
  await expect(page.getByText('No file changes in this range.')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as unknown as { slowDiffReturned: boolean }).slowDiffReturned)).toBe(true)
  await expect(page.getByText('No file changes in this range.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled()
})

test('sub-task review pauses on the per-issue diff with approve and request-changes actions', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.evaluate(async () => {
    const task = (await window.anvil.tasks.list()).find((task) => task.id === 'review')!
    window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...task, status: 'running', deliveryStatus: 'working' } }))
  })
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
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Review sidebar changes')
  await expect(page.getByLabel('Task status', { exact: true })).toContainText('Extract review actions')
  await page.getByRole('tab', { name: /^Changes/ }).click()
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
  await page.getByRole('button', { name: 'Request changes', exact: true }).click()
  await expect.poll(calls).toContainEqual({ kind: 'fixture:issue-rejection', detail: { taskId: 'review', comment: 'Also cover the empty case' } })
  // Rework restarts the issue; the next review submission refetches the diff.
  const rework = structuredClone(snapshot)
  rework.children[1].status = 'working'
  await publish(rework)
  await expect(review).toHaveCount(0)
  rework.children[1].status = 'review'
  await publish(rework)
  await expect(review.getByRole('combobox', { name: 'Changed file' })).toHaveValue('src/sidebar.ts')
  await expect(review.getByLabel('Rework feedback')).toHaveValue('')
  await page.screenshot({ path: testInfo.outputPath('subtask-review-wide.png') })
  await page.setViewportSize({ width: 900, height: 650 })
  await page.screenshot({ path: testInfo.outputPath('subtask-review-narrow.png') })
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect.poll(calls).toContainEqual({ kind: 'fixture:issue-approval', detail: { taskId: 'review' } })
  await page.screenshot({ path: testInfo.outputPath('subtask-review.png') })
})

test('review gives Pierre the full width, with file navigation and a preserved output draft', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/tests/e2e/fixture/?scenario=review')
  const output = page.getByRole('region', { name: 'Output', exact: true })
  await expect(output.getByText('system', { exact: true })).toBeVisible()
  // The prompt opens the transcript instead of taking a fixed band above it.
  const prompt = output.getByRole('region', { name: 'Task prompt' })
  await expect(prompt).toContainText('Keep the task list readable')
  expect((await prompt.boundingBox())!.y).toBeLessThan((await output.getByText('system', { exact: true }).boundingBox())!.y)
  await page.getByRole('textbox', { name: 'Message to agent' }).fill('Keep this draft while reviewing')
  await page.getByRole('tab', { name: /^Changes/ }).click()
  const review = page.getByRole('region', { name: 'Code changes' })
  const file = review.getByRole('combobox', { name: 'Changed file' })
  await expect(file).toHaveValue('src/sidebar.ts')
  await expect(review.locator('[data-diff-type="single"][data-overflow="wrap"]')).toBeVisible()
  await expect(review.locator('[data-line]').filter({ hasText: 'spacing: 12' })).toBeVisible()
  await expect(output).toBeHidden()
  // The steering bar stays available across panels while the task is live.
  await expect(page.getByRole('form', { name: 'Steer task' })).toBeVisible()
  const reviewBounds = (await review.boundingBox())!
  const mainBounds = (await page.getByRole('main').boundingBox())!
  expect(reviewBounds.width).toBeGreaterThanOrEqual(mainBounds.width - 2)
  await expect(review.getByRole('button', { name: 'Previous' })).toBeDisabled()
  await review.getByRole('checkbox', { name: 'Viewed' }).check()
  await expect(review.getByText('1 of 2 viewed')).toBeVisible()
  await review.getByRole('button', { name: 'Next file' }).click()
  await expect(file).toHaveValue('README.md')
  await expect(review.getByRole('checkbox', { name: 'Viewed' })).not.toBeChecked()
  await expect(review.getByRole('button', { name: 'Next file' })).toBeDisabled()
  await file.selectOption('src/sidebar.ts')
  await expect(review.getByRole('checkbox', { name: 'Viewed' })).toBeChecked()
  await page.screenshot({ path: testInfo.outputPath('task-review.png') })
  await page.getByRole('tab', { name: 'Output' }).click()
  await expect(output.getByRole('log', { name: 'Task output' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Message to agent' })).toHaveValue('Keep this draft while reviewing')
  expect(errors).toEqual([])
})

test('Pierre line comments and approval remain available', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.getByRole('tab', { name: /^Changes/ }).click()
  const review = page.getByRole('region', { name: 'Code changes' })
  const approve = page.getByRole('button', { name: 'Approve', exact: true })
  await expect(review.getByText('Select a line to comment')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Send \d+ comments?$/ })).toHaveCount(0)
  await review.locator('[data-column-number="2"][data-line-type="change-addition"]').click()
  await review.getByPlaceholder('Leave a note on this line…').fill('Keep this spacing consistent')
  await review.getByRole('button', { name: 'Add comment', exact: true }).click()
  await expect(review.getByText('Keep this spacing consistent', { exact: true })).toBeVisible()
  await expect(review.getByText('1 comment pending')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Send 1 comment', exact: true })).toBeEnabled()
  await review.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(review.getByText('Keep this spacing consistent', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Send \d+ comments?$/ })).toHaveCount(0)
  await review.locator('summary').click()
  await expect(review.getByRole('button', { name: 'Rebase', exact: true })).toBeEnabled()
  await expect(review.getByText('Update sidebar spacing')).toBeVisible()
  await approve.click()
  const confirmation = page.getByRole('alertdialog', { name: 'Merge and approve?' })
  await expect(confirmation).toContainText('anvil/review')
  await expect(confirmation).toContainText('user-current')
  await expect(confirmation).toContainText('3 commits will be brought in')
  await page.screenshot({ path: testInfo.outputPath('merge-confirmation.png') })
  await confirmation.getByRole('button', { name: 'Cancel' }).click()
  await expect(confirmation).toBeHidden()
  await expect(approve).toBeFocused()
  await approve.click()
  await confirmation.getByRole('button', { name: 'Merge and approve', exact: true }).click()
  await expect(confirmation.getByRole('button', { name: 'Merging…' })).toBeDisabled()
  await expect(confirmation).toBeHidden()
  // Approval retires the button; the header status carries the result and the PR action stays.
  await expect(approve).toHaveCount(0)
  await expect(page.getByRole('main').getByText('Approved', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open PR', exact: true })).toBeEnabled()
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
  await expect(page.getByRole('form', { name: 'Steer task' })).toBeVisible()
  await page.getByRole('tab', { name: 'Output' }).click()
  await expect(page.getByRole('form', { name: 'Steer task' })).toBeVisible()
})


declare global {
  interface Window {
    finalizedReview: {
      ready: (head: string) => void
      rework: () => void
      complete: (changed: boolean) => void
      resolveIssue: (index: number, file: string) => void
      resolveTask: (index: number, file: string) => void
      issueReads: number
      taskReads: number
    }
  }
}

async function deferredReview(page: import('@playwright/test').Page) {
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await expect(page.getByRole('log')).toContainText('The sidebar spacing is updated')
  await page.evaluate(async () => {
    let task = (await window.anvil.tasks.list()).find((task) => task.id === 'review')!
    const snapshot: TaskIssueSnapshot = {
      parent: { id: 'plan', title: 'Finalized plan', description: '' },
      execution: { phase: 'working', currentIssueId: 'changed', error: null }, reviewReady: false,
      children: [
        { id: 'noop', parentId: 'plan', title: 'Verify configuration', description: '', status: 'complete', completedAt: 1,
          checklist: [], validation: '', labels: [], priority: 'medium', dependencies: [] },
        { id: 'changed', parentId: 'plan', title: 'Save sidebar changes', description: '', status: 'review', baseCommit: 'base',
          checklist: [], validation: '', labels: [], priority: 'medium', dependencies: [] }
      ]
    }
    const issueResponses: Array<(diff: import('../../src/shared/types').TaskDiff) => void> = []
    const taskResponses: typeof issueResponses = []
    const patch = (file: string) => file ? `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n@@ -0,0 +1 @@\n+Finalized change\n` : ''
    const publish = () => {
      window.dispatchEvent(new CustomEvent('fixture:issues', { detail: { taskId: task.id, snapshot: structuredClone(snapshot) } }))
      window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: task }))
    }
    window.anvil.tasks.issueDiff = () => new Promise((resolve) => {
      issueResponses.push(resolve)
      window.finalizedReview.issueReads++
    })
    window.anvil.tasks.diff = () => new Promise((resolve) => {
      taskResponses.push(resolve)
      window.finalizedReview.taskReads++
    })
    window.finalizedReview = {
      issueReads: 0, taskReads: 0,
      ready(head) {
        snapshot.children[1].status = 'review'
        snapshot.children[1].headCommit = head
        snapshot.execution!.phase = 'reviewing'
        snapshot.reviewReady = true
        task = { ...task, status: 'running', deliveryStatus: 'working', headCommit: head, filesChanged: 1, additions: 1 }
        publish()
      },
      rework() {
        snapshot.children[1].status = 'review'
        snapshot.execution!.phase = 'working'
        snapshot.reviewReady = false
        task = { ...task, status: 'running', deliveryStatus: 'finalizing' }
        publish()
      },
      complete(changed) {
        snapshot.children[1].status = 'complete'
        snapshot.children[1].completedAt = 2
        snapshot.children[1].reviewedAt = changed ? 2 : undefined
        snapshot.reviewReady = false
        snapshot.execution = { phase: 'complete', currentIssueId: null, error: null }
        task = { ...task, status: 'succeeded', deliveryStatus: changed ? 'reviewable' : 'no_changes',
          headCommit: changed ? 'combined' : 'base', filesChanged: changed ? 1 : 0, additions: changed ? 1 : 0, deletions: 0 }
        publish()
      },
      resolveIssue(index, file) { issueResponses[index]({ patch: patch(file), commits: [] }) },
      resolveTask(index, file) { taskResponses[index]({ patch: patch(file), commits: [] }) }
    }
    window.finalizedReview.rework()
  })
}

for (const width of [900, 1440]) {
  test(`finalization shows saving, loaded review and verified no-change Done at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 })
    await deferredReview(page)
    const owner = page.getByRole('button', { name: 'Open task: Review sidebar changes', exact: true })
    const approve = page.getByRole('button', { name: 'Approve', exact: true })
    await expect(owner.getByRole('img', { name: 'Saving changes…', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Expand subtasks: Review sidebar changes', exact: true }).click()
    const children = page.getByRole('list', { name: 'Subtasks of Review sidebar changes' })
    await expect(children).toContainText('Verify configurationDone')
    await expect(children).toContainText('Save sidebar changesSaving changes…')
    await page.getByRole('tab', { name: /^Changes/ }).click()
    await expect(approve).toBeDisabled()
    await expect(page.getByRole('region', { name: 'Subtask code changes' })).toContainText('Saving changes…')
    expect(await page.evaluate(() => window.finalizedReview.issueReads)).toBe(0)
    await page.screenshot({ path: testInfo.outputPath(`saving-${width}.png`) })
    // Navigate immediately after readiness, while the requested committed diff is deferred.
    await page.getByRole('button', { name: 'Open task: Build streaming support', exact: true }).click()
    await page.evaluate(() => window.finalizedReview.ready('saved-head'))
    await owner.click()
    await page.getByRole('tab', { name: /^Changes/ }).click()
    await expect.poll(() => page.evaluate(() => window.finalizedReview.issueReads)).toBe(1)
    await expect(approve).toBeDisabled()
    await expect(page.getByRole('combobox', { name: 'Changed file' })).toHaveCount(0)
    await expect(page.getByText('No file changes in this range.')).toHaveCount(0)
    await page.evaluate(() => window.finalizedReview.resolveIssue(0, 'saved.ts'))
    await expect(page.getByRole('combobox', { name: 'Changed file' })).toHaveValue('saved.ts')
    await expect(approve).toBeEnabled()
    await expect(approve).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: testInfo.outputPath(`populated-${width}.png`) })
    await page.evaluate(() => window.finalizedReview.rework())
    await expect(approve).toBeDisabled()
    await page.evaluate(() => window.finalizedReview.ready('obsolete-head'))
    await expect.poll(() => page.evaluate(() => window.finalizedReview.issueReads)).toBe(2)
    await page.evaluate(() => window.finalizedReview.complete(false))
    await expect(page.getByLabel('Task status', { exact: true })).toContainText('Done')
    await expect(owner.getByRole('img', { name: 'Done', exact: true })).toBeVisible()
    await expect(approve).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Open PR', exact: true })).toHaveCount(0)
    await expect(page.getByText('No code changes to review.')).toBeVisible()
    await page.evaluate(() => window.finalizedReview.resolveIssue(1, 'obsolete.ts'))
    await expect(page.getByRole('combobox', { name: 'Changed file' })).toHaveCount(0)
    expect(await page.evaluate(() => window.finalizedReview.taskReads)).toBe(0)
    await page.screenshot({ path: testInfo.outputPath(`done-${width}.png`) })
    for (const stage of ['saving', 'populated', 'done']) {
      await testInfo.attach(`${stage}-${width}`, { path: testInfo.outputPath(`${stage}-${width}.png`), contentType: 'image/png' })
    }
  })
}

test('mixed-plan aggregate rejects obsolete heads, navigation and deletion responses', async ({ page }, testInfo) => {
  await deferredReview(page)
  await page.evaluate(() => window.finalizedReview.complete(true))
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await expect.poll(() => page.evaluate(() => window.finalizedReview.taskReads)).toBe(1)
  await expect(page.getByRole('tab', { name: /^Changes/ })).toContainText('Loading…')
  const other = page.getByRole('button', { name: 'Open task: Build streaming support', exact: true })
  const owner = page.getByRole('button', { name: 'Open task: Review sidebar changes', exact: true })
  await other.click()
  await owner.click()
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await expect.poll(() => page.evaluate(() => window.finalizedReview.taskReads)).toBe(2)
  await page.evaluate(async () => {
    const task = (await window.anvil.tasks.list()).find((task) => task.id === 'review')!
    window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...task, headCommit: 'new-aggregate' } }))
  })
  await expect.poll(() => page.evaluate(() => window.finalizedReview.taskReads)).toBe(3)
  await page.evaluate(() => {
    window.finalizedReview.resolveTask(2, 'combined.ts')
    window.finalizedReview.resolveTask(1, '')
    window.finalizedReview.resolveTask(0, 'obsolete.ts')
  })
  const file = page.getByRole('combobox', { name: 'Changed file' })
  await expect(file).toHaveValue('combined.ts')
  await page.getByRole('button', { name: 'Expand subtasks: Review sidebar changes', exact: true }).click()
  const children = page.getByRole('list', { name: 'Subtasks of Review sidebar changes' })
  await expect(children).toContainText('Verify configurationDone')
  await expect(children).toContainText('Save sidebar changesApproved')
  for (const width of [900, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeInViewport({ ratio: 1 })
    expect((await file.boundingBox())!.width).toBeGreaterThan(200)
    await page.screenshot({ path: testInfo.outputPath(`mixed-final-${width}.png`) })
    await testInfo.attach(`mixed-final-${width}`, { path: testInfo.outputPath(`mixed-final-${width}.png`), contentType: 'image/png' })
  }
  // Same head metadata updates retain the populated cache.
  await page.evaluate(async () => {
    const task = (await window.anvil.tasks.list()).find((task) => task.id === 'review')!
    window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...task, totalTokens: 42 } }))
  })
  await expect(file).toHaveValue('combined.ts')
  expect(await page.evaluate(() => window.finalizedReview.taskReads)).toBe(3)
  await page.evaluate(async () => {
    const task = (await window.anvil.tasks.list()).find((task) => task.id === 'review')!
    window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...task, headCommit: 'deleted-head' } }))
  })
  await expect.poll(() => page.evaluate(() => window.finalizedReview.taskReads)).toBe(4)
  await owner.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  await page.getByRole('dialog', { name: 'Delete task?' }).getByRole('button', { name: 'Delete task', exact: true }).click()
  await page.evaluate(() => window.finalizedReview.resolveTask(3, 'deleted.ts'))
  await expect(owner).toHaveCount(0)
  await expect(file).toHaveCount(0)
})
