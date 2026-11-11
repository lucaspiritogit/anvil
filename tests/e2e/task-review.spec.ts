import { expect, test } from '@playwright/test'
import type { TaskIssueSnapshot } from '@anvil/protocol/types'

test('review gives Pierre the full width, with per-file viewed state and a preserved output draft', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 })
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
  const sidebar = review.getByRole('region', { name: 'src/sidebar.ts' })
  const readme = review.getByRole('region', { name: 'README.md' })
  await expect(sidebar).toBeVisible()
  await expect(readme).toBeVisible()
  await expect(review.locator('[data-diff-type="single"][data-overflow="wrap"]')).toHaveCount(2)
  await expect(sidebar.locator('[data-line]').filter({ hasText: 'spacing: 12' })).toBeVisible()
  await expect(output).toBeHidden()
  // The steering bar stays available across panels while the task is live.
  await expect(page.getByRole('form', { name: 'Steer task' })).toBeVisible()
  const reviewBounds = (await review.boundingBox())!
  const mainBounds = (await page.getByRole('main').boundingBox())!
  expect(reviewBounds.width).toBeGreaterThanOrEqual(mainBounds.width - 2)
  // Checking Viewed collapses the file; its title re-expands it without clearing the mark.
  await sidebar.getByRole('checkbox', { name: 'Viewed' }).check()
  await expect(review.getByText('1 of 2 viewed')).toBeVisible()
  await expect(sidebar.getByRole('button', { name: 'src/sidebar.ts' })).toHaveAttribute('aria-expanded', 'false')
  await expect(sidebar.locator('[data-line]')).toHaveCount(0)
  await expect(readme.getByRole('checkbox', { name: 'Viewed' })).not.toBeChecked()
  await expect(readme.getByRole('button', { name: 'README.md' })).toHaveAttribute('aria-expanded', 'true')
  await sidebar.getByRole('button', { name: 'src/sidebar.ts' }).click()
  await expect(sidebar.getByRole('button', { name: 'src/sidebar.ts' })).toHaveAttribute('aria-expanded', 'true')
  await expect(sidebar.getByRole('checkbox', { name: 'Viewed' })).toBeChecked()
  await sidebar.getByRole('checkbox', { name: 'Viewed' }).uncheck()
  await expect(review.getByText('0 of 2 viewed')).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('task-review.png') })
  await page.getByRole('tab', { name: 'Output' }).click()
  await expect(output.getByRole('log', { name: 'Task output' })).toBeVisible()
  await expect(page.getByRole('textbox', { name: 'Message to agent' })).toHaveValue('Keep this draft while reviewing')
  expect(errors).toEqual([])
})

test('file headers stay pinned while scrolling through every change', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.evaluate(async () => {
    const patch = ['alpha.ts', 'beta.ts', 'gamma.ts'].map((name) =>
      `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n@@ -0,0 +1,60 @@\n${Array.from({ length: 60 }, (_, index) => `+${name} line ${index + 1}`).join('\n')}\n`
    ).join('')
    window.anvil.tasks.diff = async () => ({ patch, commits: [] })
    const { useStore } = await import('/apps/web/src/state/store.ts')
    useStore.setState({ diffsByTask: {} })
    await useStore.getState().loadTaskDiff('review')
  })
  await page.getByRole('tab', { name: /^Changes/ }).click()
  const review = page.getByRole('region', { name: 'Code changes' })
  const scroller = review.locator('[data-diff-scroller]')
  const gamma = review.getByRole('button', { name: 'gamma.ts', exact: true })
  await expect(gamma).toBeVisible()
  await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight })
  const headerBox = (await gamma.boundingBox())!
  const scrollerBox = (await scroller.boundingBox())!
  expect(headerBox.y - scrollerBox.y).toBeLessThan(8)
  // The previous file's header is pushed out of the way rather than overlapping.
  const betaBox = (await review.getByRole('button', { name: 'beta.ts', exact: true }).boundingBox())!
  expect(betaBox.y + betaBox.height).toBeLessThanOrEqual(headerBox.y + 1)
})

test('line comments go to the agent and a held Ship commits and pushes the task', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.evaluate(() => {
    const calls: unknown[] = []
    Object.assign(window, { shipCalls: calls })
    window.addEventListener('fixture:ship', (event) => calls.push((event as CustomEvent).detail))
  })
  await page.getByRole('tab', { name: /^Changes/ }).click()
  const review = page.getByRole('region', { name: 'Code changes' })
  const ship = page.getByRole('button', { name: /^Ship( to |$)/ })
  await expect(review.getByText('Select a line to leave a note for the agent')).toBeVisible()
  const notes = page.getByRole('list', { name: 'Notes for the agent' })
  await expect(notes).toHaveCount(0)
  await review.getByRole('region', { name: 'src/sidebar.ts' }).locator('[data-column-number="2"][data-line-type="change-addition"]').click()
  await review.getByPlaceholder('Leave a note on this line…').fill('Keep this spacing consistent')
  await review.getByRole('button', { name: 'Add comment', exact: true }).click()
  await expect(review.getByText('Keep this spacing consistent', { exact: true })).toBeVisible()
  await expect(review.getByText('1 note waiting in the message box')).toBeVisible()
  await expect(notes.getByRole('listitem')).toHaveText(['sidebar.ts:2Keep this spacing consistent×'])
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled()
  await notes.getByRole('button', { name: 'Remove note: Keep this spacing consistent' }).click()
  await expect(review.getByText('Keep this spacing consistent', { exact: true })).toHaveCount(0)
  await expect(notes).toHaveCount(0)
  await ship.click({ delay: 1000 })
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(ship).toHaveCount(0)
  await expect(page.getByRole('main').getByText('Shipped', { exact: true })).toHaveCSS('color', 'rgb(95, 211, 138)')
  await expect(page.getByRole('button', { name: 'Push', exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { shipCalls: unknown[] }).shipCalls)).toEqual([{ taskId: 'review', push: true }])
  await page.screenshot({ path: testInfo.outputPath('shipped.png') })
  await expect(page.getByText('Shipped & pushed', { exact: true })).toBeVisible()
})

test('the Ship menu offers an editable message', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.evaluate(() => {
    const calls: unknown[] = []
    Object.assign(window, { shipCalls: calls })
    window.addEventListener('fixture:ship', (event) => calls.push((event as CustomEvent).detail))
  })
  await page.getByRole('button', { name: 'More ship actions' }).click()
  const menu = page.getByRole('menu', { name: 'Ship actions' })
  await expect(menu.getByRole('menuitem')).toHaveText(['Ship with message…', 'Open pull request…'])
  await menu.getByRole('menuitem', { name: 'Ship with message…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Ship & push', exact: true })
  await expect(dialog).toContainText('Squash')
  await expect(dialog.getByRole('button', { name: 'Ship & push', exact: true })).toBeDisabled()
  await dialog.getByRole('button', { name: 'Generate commit message with Codex' }).click()
  await expect(dialog.getByRole('textbox', { name: 'Commit message' })).toHaveValue('fix: clamp output rows by measured truncation')
  await dialog.getByRole('textbox', { name: 'Commit message' }).fill('feat: tighten sidebar spacing')
  await dialog.getByRole('button', { name: 'Ship & push', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByLabel('Task status', { exact: true })).toContainText('Shipped')
  expect(await page.evaluate(() => (window as unknown as { shipCalls: unknown[] }).shipCalls))
    .toEqual([{ taskId: 'review', push: true, message: 'feat: tighten sidebar spacing' }])
})

test('ship errors stay next to the button without shipping the task', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=review&mergeFailure=1')
  await page.getByRole('tab', { name: /^Changes/ }).click()
  const ship = page.getByRole('button', { name: /^Ship( to |$)/ })
  await ship.click({ delay: 1000 })
  await expect(page.getByRole('alert').filter({ hasText: 'Merge failed. The task was not merged.' })).toBeVisible()
  await expect(ship).toBeEnabled()
  await expect(page.getByLabel('Task status', { exact: true })).toContainText('Ready to ship')
})

test('ship conflicts stay in progress while the agent resolves them', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/?scenario=review&mergeConflict=1')
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await page.getByRole('button', { name: /^Ship( to |$)/ }).click({ delay: 1000 })

  await expect(page.getByRole('tab', { name: 'Output', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByLabel('Task status', { exact: true })).toContainText('Resolving conflicts with user-current')
  await expect(page.getByRole('img', { name: 'Resolving conflicts' }).first()).toBeVisible()
  const output = page.getByRole('region', { name: 'Output', exact: true })
  await expect(output.getByRole('log', { name: 'Task output' })).toBeVisible()
  await expect(output.getByRole('status', { name: 'Agent activity' })).toContainText('Resolving merge conflicts with user-current')
  await expect(page.getByRole('button', { name: /Abort merge|Fix with agent|Complete merge|Refresh conflicts/ })).toHaveCount(0)
  await expect(page.getByText(/CONFLICT \(content\)/)).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('merge-conflict-resolving.png') })

  await page.evaluate(() => window.mergeConflictTest.resolve())
  await expect(page.getByLabel('Task status', { exact: true })).toContainText('Shipped')
  await expect(output.getByRole('status', { name: 'Agent activity' })).toHaveCount(0)
})

test('a checkout that cannot be shipped reports why', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=review&mergePreviewFailure=1')
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await page.getByRole('button', { name: /^Ship( to |$)/ }).click({ delay: 1000 })
  await expect(page.getByRole('alert').filter({ hasText: 'Check out a branch before merging' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Ship( to |$)/ })).toBeEnabled()
})

test('narrow review switches panels without losing viewed state or steering drafts', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 500 })
  await page.goto('/tests/e2e/fixture/?scenario=review')
  await page.getByRole('tab', { name: /^Changes/ }).click()
  const review = page.getByRole('region', { name: 'Code changes' })
  const readme = review.getByRole('region', { name: 'README.md' })
  await expect(review.getByText('0 of 2 viewed')).toBeInViewport({ ratio: 1 })
  await readme.getByRole('checkbox', { name: 'Viewed' }).check()
  await expect(readme.getByRole('button', { name: 'README.md' })).toHaveAttribute('aria-expanded', 'false')
  await page.getByRole('tab', { name: 'Output' }).click()
  await expect(review).toBeHidden()
  const input = page.getByRole('textbox', { name: 'Message to agent' })
  await input.fill('Preserve this follow-up')
  await page.getByRole('tab', { name: 'Changes' }).click()
  await expect(readme.getByRole('checkbox', { name: 'Viewed' })).toBeChecked()
  await expect(readme.getByRole('button', { name: 'README.md' })).toHaveAttribute('aria-expanded', 'false')
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
  await expect(page.getByRole('region', { name: 'src/sidebar.ts' })).toBeVisible()
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
    const issueResponses: Array<(diff: import('@anvil/protocol/types').TaskDiff) => void> = []
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
        task = { ...task, status: 'running', deliveryStatus: 'working', headCommit: head, filesChanged: 1, additions: 1, deletions: 0 }
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
  const file = page.getByRole('region', { name: 'combined.ts' })
  await expect(file).toBeVisible()
  await page.getByRole('button', { name: 'Expand subtasks: Review sidebar changes', exact: true }).click()
  const children = page.getByRole('list', { name: 'Subtasks of Review sidebar changes' })
  await expect(children).toContainText('Verify configurationDone')
  await expect(children).toContainText('Save sidebar changesApproved')
  for (const width of [900, 1440]) {
    await page.setViewportSize({ width, height: 900 })
    await expect(page.getByRole('button', { name: /^Ship( to |$)/ })).toBeInViewport({ ratio: 1 })
    expect((await file.boundingBox())!.width).toBeGreaterThan(200)
    await page.screenshot({ path: testInfo.outputPath(`mixed-final-${width}.png`) })
    await testInfo.attach(`mixed-final-${width}`, { path: testInfo.outputPath(`mixed-final-${width}.png`), contentType: 'image/png' })
  }
  // Same head metadata updates retain the populated cache.
  await page.evaluate(async () => {
    const task = (await window.anvil.tasks.list()).find((task) => task.id === 'review')!
    window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...task, totalTokens: 42 } }))
  })
  await expect(file).toBeVisible()
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
