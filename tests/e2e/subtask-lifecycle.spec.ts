import { expect, test } from '@playwright/test'
import type { TaskEvent, TaskIssueSnapshot } from '../../src/shared/types'
import { restoreComposerSelection } from './composer-setup'

test('a newly created task discovers planning children and keeps execution and review on its owner', async ({ page }) => {
  await restoreComposerSelection(page)
  await page.goto('/tests/e2e/fixture/')
  const composer = page.getByRole('form', { name: 'Start a task' })
  await composer.getByRole('textbox').fill('Build sidebar lifecycle')
  await composer.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Build sidebar lifecycle')
  const task = await page.evaluate(async () => (await window.anvil.tasks.list()).find((item) => item.id.startsWith('started-'))!)
  const sidebar = page.getByRole('complementary', { name: 'Task sidebar' })
  const rows = sidebar.getByRole('list', { name: 'Subtasks of Build sidebar lifecycle' })
  const parent = sidebar.getByRole('button', { name: 'Open task: Build sidebar lifecycle', exact: true })
  await expect(rows).toHaveCount(0)
  await page.evaluate(async () => {
    const { pageTaskEvents } = await import('/tests/e2e/fixture/task-events.ts')
    const mutations: string[] = []
    Object.assign(window, { lifecycleMutations: mutations })
    for (const method of ['start', 'steer', 'cancel', 'approve', 'settle', 'delete'] as const) {
      const original = window.anvil.tasks[method] as (...args: unknown[]) => unknown
      Object.assign(window.anvil.tasks, { [method]: (...args: unknown[]) => {
        mutations.push(method)
        return original(...args)
      } })
    }
    const history: TaskEvent[] = []
    window.anvil.tasks.eventsPage = async (input) => pageTaskEvents(history, input)
    window.addEventListener('fixture:output', (event) => history.push((event as CustomEvent<TaskEvent>).detail))
  })
  const snapshot: TaskIssueSnapshot = {
    parent: { id: 'plan', title: task.title, description: '' }, children: []
  }
  const publish = () => page.evaluate(({ taskId, snapshot }) => {
    window.dispatchEvent(new CustomEvent('fixture:issues', { detail: { taskId, snapshot } }))
  }, { taskId: task.id, snapshot })
  const emit = (text: string, issueId?: string) => page.evaluate((event) => {
    window.dispatchEvent(new CustomEvent('fixture:output', { detail: event }))
  }, { id: text, taskId: task.id, issueId, text, ts: Date.now(), stream: 'stdout', kind: 'output', category: 'message' })
  await publish()
  await expect(rows).toHaveCount(0)
  await emit('Parent planning history')
  for (const title of ['Implement rows', 'Validate navigation']) {
    snapshot.children.push({ id: title, parentId: 'plan', title, description: title,
      status: 'queued', checklist: ['Verified'], validation: 'Run tests', labels: [], priority: 'medium',
      dependencies: snapshot.children.length ? ['Implement rows'] : [] })
    await publish()
    if (snapshot.children.length === 1) {
      await sidebar.getByRole('button', { name: `Expand subtasks: ${task.title}`, exact: true }).click()
    }
    await expect(rows.getByRole('listitem')).toHaveCount(snapshot.children.length)
  }
  const first = rows.getByRole('listitem').first()
  const second = rows.getByRole('listitem').nth(1)
  await first.click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(task.title)
  await expect(page.getByRole('log')).toContainText('Parent planning history')
  await expect(rows.locator('button, a, [tabindex], [aria-current]')).toHaveCount(0)
  await page.evaluate(() => {
    const calls: { kind: string; detail: unknown }[] = []
    Object.assign(window, { issueReviewCalls: calls })
    for (const name of ['fixture:issue-approval', 'fixture:issue-rejection']) {
      window.addEventListener(name, (event) => calls.push({ kind: name, detail: (event as CustomEvent).detail }))
    }
  })
  const reviewCalls = (): { kind: string; detail: unknown }[] =>
    page.evaluate(() => (window as unknown as { issueReviewCalls: { kind: string; detail: unknown }[] }).issueReviewCalls)
  for (let index = 0; index < snapshot.children.length; index++) {
    const child = snapshot.children[index]
    child.status = 'working'
    child.startedAt = Date.UTC(2026, 8, 9, 12, index)
    await publish()
    await (index ? second : first).click()
    await page.getByRole('tab', { name: 'Output', exact: true }).click()
    await expect(page.getByLabel('Task status', { exact: true })).toHaveText(`Working: ${child.title}`)
    await emit(`Result for ${child.title}`, child.id)
    await expect(page.getByRole('log')).toContainText(`Result for ${child.title}`)
    child.status = 'review'
    await publish()
    await expect(page.getByLabel('Task status', { exact: true })).toHaveText(`Review: ${child.title}`)
    await expect((index ? second : first)).toContainText('Review')
    // The run indicator becomes a review gate while the agent waits.
    await expect(page.getByRole('status', { name: 'Review gate' })).toBeVisible()
    await page.getByRole('tab', { name: 'Changes', exact: true }).click()
    const review = page.getByRole('region', { name: 'Subtask code changes' })
    await expect(review.getByRole('status')).toContainText('Waiting for your review')
    await expect(review.getByRole('combobox', { name: 'Changed file' })).toBeVisible()
    if (index === 0) {
      // Approving lets the agent continue with the next queued issue.
      await page.getByRole('button', { name: 'Approve', exact: true }).click()
      await expect.poll(reviewCalls).toEqual([{ kind: 'fixture:issue-approval', detail: { taskId: task.id } }])
    } else {
      // Requesting changes sends the optional note and restarts the same issue.
      await review.getByLabel('Rework feedback').fill('Tighten the row spacing')
      await page.getByRole('button', { name: 'Request changes', exact: true }).click()
      await expect.poll(reviewCalls).toEqual([
        { kind: 'fixture:issue-approval', detail: { taskId: task.id } },
        { kind: 'fixture:issue-rejection', detail: { taskId: task.id, comment: 'Tighten the row spacing' } }
      ])
      child.status = 'working'
      await publish()
      await expect(page.getByLabel('Task status', { exact: true })).toHaveText(`Working: ${child.title}`)
      child.status = 'review'
      await publish()
      await expect(page.getByLabel('Task status', { exact: true })).toHaveText(`Review: ${child.title}`)
      await page.getByRole('button', { name: 'Approve', exact: true }).click()
      await expect.poll(() => reviewCalls().then((calls) => calls.length)).toBe(3)
    }
    child.status = 'complete'
    child.completedAt = child.startedAt + 60_000
    await publish()
  }
  await page.getByRole('tab', { name: 'Output', exact: true }).click()
  await parent.click()
  for (const text of ['Parent planning history', 'Result for Implement rows', 'Result for Validate navigation']) {
    await expect(page.getByRole('log')).toContainText(text)
  }
  expect(await page.evaluate(() => (window as unknown as { lifecycleMutations: string[] }).lifecycleMutations)).toEqual([])
  // Steering remains an explicit parent action after reviewing both children.
  await page.evaluate((task) => window.dispatchEvent(new CustomEvent('fixture:task-updated', {
    detail: { ...task, sessionId: 'lifecycle-session' }
  })), task)
  await page.getByRole('textbox', { name: 'Message to agent' }).fill('Check the narrow layout')
  await page.getByRole('textbox', { name: 'Message to agent' }).press('Control+Enter')
  await expect.poll(() => page.evaluate(() => (window as unknown as { lifecycleMutations: string[] }).lifecycleMutations)).toEqual(['steer'])
  await expect(page.getByRole('button', { name: 'Sending...' })).toHaveCount(0)
  await page.evaluate((task) => window.dispatchEvent(new CustomEvent('fixture:task-updated', {
    detail: { ...task, status: 'succeeded', deliveryStatus: 'reviewable', endedAt: Date.now(), filesChanged: 2 }
  })), task)
  await second.click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(task.title)
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await expect(page.getByRole('region', { name: 'Code changes' })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Changed file' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Approve', exact: true })).toBeEnabled()
})
