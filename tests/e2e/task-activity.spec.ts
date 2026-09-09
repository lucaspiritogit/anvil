import { expect, test, type Page } from '@playwright/test'
import type { Task, TaskEvent } from '../../src/shared/types'

async function emitOutput(page: Page, event: Pick<TaskEvent, 'id' | 'category' | 'text'>): Promise<void> {
  await page.evaluate((detail) => {
    window.dispatchEvent(new CustomEvent('fixture:output', {
      detail: { taskId: 'output', ts: Date.now(), stream: 'stdout', kind: 'output', ...detail }
    }))
  }, event)
}

async function updateTask(page: Page, patch: Partial<Task>): Promise<void> {
  await page.evaluate(async (patch) => {
    const task = (await window.anvil.tasks.list()).find((task) => task.id === 'output')!
    window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...task, ...patch } }))
  }, patch)
}

test('activity breathes while waiting and follows thinking, tool calls, results, and messages', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&steering=1&running=1&emptyOutput=1')
  const output = page.getByRole('log', { name: 'Task output' })
  const activity = output.getByRole('status', { name: 'Agent activity' })
  await expect(activity).toHaveText('Working…')
  await expect(activity.locator('span')).toHaveCSS('animation-name', 'breathe')
  await expect(activity.locator('span')).toHaveCSS('animation-iteration-count', 'infinite')
  const animationTime = await activity.locator('span').evaluate((element) => Number(element.getAnimations()[0].currentTime))
  await expect.poll(() => activity.locator('span').evaluate((element) => Number(element.getAnimations()[0].currentTime))).toBeGreaterThan(animationTime)
  await expect(output.locator('[data-output-category]')).toHaveCount(0)

  await emitOutput(page, { id: 'thinking', category: 'thinking', text: 'Checking how the sidebar handles focus' })
  await expect(activity).toHaveText('Thinking…')
  await emitOutput(page, { id: 'tool-use:shell', category: 'tool_use', text: 'Shell\nnpm run typecheck' })
  await expect(activity).toHaveText('Running Shell…')
  await expect(output.getByText('Checking how the sidebar handles focus', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('agent-activity.png') })

  await emitOutput(page, { id: 'tool-result:shell', category: 'tool_result', text: 'Typecheck passed' })
  await expect(activity).toHaveText('Processing tool result…')
  await expect(output.getByText('Typecheck passed', { exact: true })).toBeVisible()
  await emitOutput(page, { id: 'message', category: 'message', text: 'The changes are ready' })
  await expect(activity).toHaveText('Writing a response…')
  await emitOutput(page, { id: 'message', category: 'message', text: 'The changes are ready for review.' })
  await expect(output.locator('[data-output-category="message"]')).toHaveCount(1)
  await expect(output.getByText('The changes are ready for review.', { exact: true })).toBeVisible()
  await expect(activity).toHaveCount(1)

  await updateTask(page, { status: 'succeeded', deliveryStatus: 'no_changes' })
  await expect(activity).toHaveCount(0)
  await expect(output.getByText('The changes are ready for review.', { exact: true })).toBeVisible()
})

test('delivery phases override old activity, and failed or cancelled tasks stop animating', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&steering=1&running=1&emptyOutput=1')
  const activity = page.getByRole('status', { name: 'Agent activity' })
  await expect(activity).toHaveText('Working…')
  await emitOutput(page, { id: 'tool', category: 'tool_use', text: '\n' })
  await expect(activity).toHaveText('Running a tool…')
  for (const [deliveryStatus, label] of [
    ['preparing', 'Preparing branch…'],
    ['finalizing', 'Saving changes…'],
    ['did_not_commit', 'Committing changes…']
  ] as const) {
    await updateTask(page, { deliveryStatus })
    await expect(activity).toHaveText(label)
  }
  for (const status of ['failed', 'cancelled'] as const) {
    await updateTask(page, { status: 'running', deliveryStatus: 'working' })
    await expect(activity).toBeVisible()
    await updateTask(page, { status })
    await expect(activity).toHaveCount(0)
  }
})

test('reduced motion keeps the activity text without animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/tests/e2e/fixture/?scenario=output&steering=1&running=1&emptyOutput=1')
  const activity = page.getByRole('status', { name: 'Agent activity' })
  await expect(activity).toHaveText('Working…')
  await expect(activity.locator('span')).toHaveCSS('animation-name', 'none')
  await emitOutput(page, { id: 'thinking', category: 'thinking', text: 'Checking the tests' })
  await expect(activity).toHaveText('Thinking…')
})

test('activity follows new output without pulling the reader away from earlier events', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 })
  await page.goto('/tests/e2e/fixture/?scenario=output&steering=1&running=1')
  const output = page.getByRole('log', { name: 'Task output' })
  const activity = output.getByRole('status', { name: 'Agent activity' })
  await expect(activity).toBeInViewport()
  await output.hover()
  await page.mouse.wheel(0, -100000)
  await expect(output.getByText(/^Output 0:/)).toBeInViewport()
  const scrollTop = await output.evaluate((element) => element.scrollTop)
  await emitOutput(page, { id: 'tool', category: 'tool_use', text: 'Read file\npackage.json' })
  await expect(activity).toHaveText('Running Read file…')
  expect(await output.evaluate((element) => element.scrollTop)).toBe(scrollTop)
  await page.getByRole('button', { name: 'Jump to latest' }).click()
  await expect(activity).toBeInViewport()
})
