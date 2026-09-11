import { expect, test, type Page } from '@playwright/test'

const output = (page: Page) => page.getByRole('log', { name: 'Task output' })
const rows = (page: Page) => output(page).locator('[data-event-id]')
const history = (page: Page) => page.getByRole('navigation', { name: 'Output history' })
const atBottom = (page: Page) => output(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 2)
const settled = (page: Page) => expect(output(page)).toHaveAttribute('aria-busy', 'false')

async function emit(page: Page, id: string, text: string, taskId = 'output', category = 'message'): Promise<void> {
  await page.evaluate(({ id, text, taskId, category }) => {
    window.dispatchEvent(new CustomEvent('fixture:output', { detail: {
      id, taskId, text, category, ts: Date.now(), stream: 'stdout', kind: 'output'
    } }))
  }, { id, text, taskId, category })
}

async function scrollTo(page: Page, top: number): Promise<void> {
  await output(page).evaluate((el, top) => {
    el.scrollTop = top
    el.dispatchEvent(new Event('scroll'))
  }, top)
}

async function anchor(page: Page): Promise<{ id: string; offset: number }> {
  return output(page).evaluate((el) => {
    const top = el.getBoundingClientRect().top
    const row = Array.from(el.querySelectorAll<HTMLElement>('[data-event-id]'))
      .find((row) => row.getBoundingClientRect().bottom > top)!
    return { id: row.dataset.eventId!, offset: row.getBoundingClientRect().top - top }
  })
}

async function expectAnchor(page: Page, before: { id: string; offset: number }): Promise<void> {
  await expect.poll(async () => (await anchor(page)).id).toBe(before.id)
  // scrollTop rounds fractional CSS pixels in Chromium.
  await expect.poll(async () => Math.abs((await anchor(page)).offset - before.offset)).toBeLessThanOrEqual(1)
}

test('pages past 4,000 rows in both directions with bounded retention and stable anchors', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&historySize=4500')
  await expect(rows(page)).toHaveCount(500)
  await expect(rows(page).first()).toHaveAttribute('data-event-id', 'history-4001')
  await expect.poll(() => atBottom(page)).toBe(true)
  for (let index = 0; index < 8; index++) {
    await scrollTo(page, 200)
    const before = await anchor(page)
    await page.getByRole('button', { name: 'Older output', exact: true }).click()
    await settled(page)
    await expectAnchor(page, before)
    await expect(rows(page)).toHaveCount(Math.min(1000 + index * 500, 4000))
  }
  await expect(rows(page).first()).toHaveAttribute('data-event-id', 'history-1')
  await expect(rows(page).last()).toHaveAttribute('data-event-id', 'history-4000')
  await expect(page.getByRole('button', { name: 'Older output', exact: true })).toBeDisabled()
  await scrollTo(page, 1000000)
  const before = await anchor(page)
  await page.getByRole('button', { name: 'Newer output', exact: true }).click()
  await settled(page)
  await expectAnchor(page, before)
  await expect(rows(page).first()).toHaveAttribute('data-event-id', 'history-501')
  await expect(rows(page).last()).toHaveAttribute('data-event-id', 'history-4500')
  await expect(rows(page)).toHaveCount(4000)
  await page.screenshot({ path: testInfo.outputPath('bounded-history.png') })
  await page.getByRole('button', { name: 'Jump to latest' }).click()
  await expect(rows(page)).toHaveCount(500)
  await expect.poll(() => atBottom(page)).toBe(true)
})

test('follows the live tail, preserves a reader through snapshots and hidden panels, and reloads latest', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&historySize=600&steering=1&running=1')
  await expect(rows(page)).toHaveCount(500)
  await emit(page, 'live', 'Live tail')
  await expect(rows(page).last()).toHaveText(/Live tail/)
  await expect.poll(() => atBottom(page)).toBe(true)
  await scrollTo(page, 700)
  const before = await anchor(page)
  await emit(page, 'history-101', 'Updated snapshot\nsecond line\nthird line')
  await expect(rows(page).first()).toContainText('Updated snapshot')
  await expect(rows(page)).toHaveCount(501)
  await expectAnchor(page, before)
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await expect(page.getByRole('form', { name: 'Steer task' })).toBeVisible()
  await emit(page, 'live-2', 'Output while changes are open')
  await page.getByRole('tab', { name: 'Output', exact: true }).click()
  await expectAnchor(page, before)
  await page.getByRole('button', { name: 'Older output', exact: true }).click()
  await settled(page)
  const count = await rows(page).count()
  await emit(page, 'live-3', 'Persisted while browsing history')
  await expect(rows(page)).toHaveCount(count)
  await expect(page.getByRole('button', { name: 'Newer output', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'Jump to latest' }).click()
  await expect(rows(page).last()).toContainText('Persisted while browsing history')
  await expect.poll(() => atBottom(page)).toBe(true)
  await expect(page.getByRole('status', { name: 'Agent activity' })).toContainText('Writing a response')
})

test('initial and directional loading failures retain output and retry the failed direction', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&historySize=600&outputFailure=1')
  await expect(page.getByRole('alert')).toContainText('Output history unavailable')
  await expect(output(page)).not.toContainText('No output recorded.')
  await page.getByRole('button', { name: 'Retry output' }).click()
  await expect(rows(page)).toHaveCount(500)
  for (const direction of ['Older output', 'Newer output', 'Jump to latest']) {
    if (direction === 'Newer output') await emit(page, 'new-tail', 'New tail while reading')
    if (direction === 'Jump to latest') await scrollTo(page, 0)
    const count = await rows(page).count()
    await page.evaluate(() => { window.outputTest.hold = true })
    await page.getByRole('button', { name: direction, exact: true }).click()
    await expect(output(page)).toHaveAttribute('aria-busy', 'true')
    await expect(history(page)).toContainText('Loading output…')
    await expect(page.getByRole('button', { name: 'Older output', exact: true })).toBeDisabled()
    await page.evaluate(() => { window.outputTest.hold = false; window.outputTest.release(true) })
    await expect(page.getByRole('alert')).toContainText('Output history unavailable')
    await expect(rows(page)).toHaveCount(count)
    const failed = await page.evaluate(() => window.outputTest.requests.at(-1))
    await page.getByRole('button', { name: 'Retry output' }).click()
    await settled(page)
    await expect(page.getByRole('alert')).toHaveCount(0)
    expect(await page.evaluate(() => window.outputTest.requests.at(-1))).toEqual(failed)
  }
  await expect.poll(() => atBottom(page)).toBe(true)
})

test('task, Home and project navigation evict history and reopen fresh at the tail', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&historySize=4500&steering=1&running=1')
  await expect(rows(page)).toHaveCount(500)
  await page.getByRole('button', { name: 'Older output', exact: true }).click()
  await expect(rows(page)).toHaveCount(1000)
  await page.evaluate(async () => {
    const { useStore } = await import('/src/renderer/src/state/store.ts')
    await useStore.getState().openTask('running')
  })
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Build streaming support')
  await expect(rows(page)).toHaveCount(500)
  await expect.poll(() => atBottom(page)).toBe(true)
  await emit(page, 'background', 'Background task persisted', 'output')
  expect(await page.evaluate(async () => {
    const { useStore } = await import('/src/renderer/src/state/store.ts')
    return Object.keys(useStore.getState().eventsByTask)
  })).toEqual(['running'])
  for (const destination of ['home', 'project']) {
    await page.evaluate(async (destination) => {
      const { useStore } = await import('/src/renderer/src/state/store.ts')
      if (destination === 'home') useStore.getState().showHome()
      else useStore.getState().selectProject('project-0')
    }, destination)
    expect(await page.evaluate(async () => {
      const { useStore } = await import('/src/renderer/src/state/store.ts')
      const { eventsByTask, taskEventHistory } = useStore.getState()
      return { eventsByTask, taskEventHistory }
    })).toEqual({ eventsByTask: {}, taskEventHistory: null })
    await page.evaluate(async () => {
      const { useStore } = await import('/src/renderer/src/state/store.ts')
      await useStore.getState().openTask('output')
    })
    await expect(rows(page)).toHaveCount(500)
    await expect(rows(page).last()).toContainText('Background task persisted')
    await expect.poll(() => atBottom(page)).toBe(true)
  }
})

test('prompt, tool rows, delivery messages, empty output and activity retain accessible rendering', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&tools=1&longPrompt=1&steering=1&running=1')
  await expect(rows(page)).toHaveCount(2)
  await scrollTo(page, 0)
  const prompt = page.getByRole('region', { name: 'Task prompt' })
  await prompt.getByRole('button', { name: 'Show more' }).click()
  await expect(prompt.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
  await prompt.getByRole('button', { name: 'Show less' }).click()
  const tool = output(page).locator('[data-output-category="tool_use"]')
  await tool.focus()
  await page.keyboard.press('Enter')
  await expect(tool).toHaveAttribute('aria-expanded', 'true')
  await expect(tool).toContainText('Shell')
  await expect(output(page).locator('[data-output-category="tool_result"]')).toContainText('first.ts')
  await emit(page, 'thinking', 'Considering the implementation', 'output', 'thinking')
  await expect(page.getByRole('status', { name: 'Agent activity' })).toContainText('Thinking…')
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture:output', { detail: {
    id: 'delivery', taskId: 'output', ts: 99, stream: 'system', kind: 'did_not_commit', category: 'system', text: 'Saving the final commit'
  } })))
  await expect(output(page).locator('[data-event-id="delivery"] .text-warn').first()).toBeAttached()
  await page.goto('/tests/e2e/fixture/?scenario=output&emptyOutput=1')
  await expect(output(page)).toContainText('No output recorded.')
})

test('event-only bursts commit output without TaskView, review/header owner, diff or composer commits', async ({ page }) => {
  // The succeeded review task has no elapsed-time interval. Freeze the clock as
  // well so task/issue polling cannot enter the measurement window.
  await page.clock.install()
  await page.goto('/tests/e2e/fixture/?scenario=review&renderProbe=1')
  await expect(rows(page)).toHaveCount(2)
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await expect(page.getByRole('combobox', { name: 'Changed file' })).toBeVisible()
  await page.getByRole('tab', { name: 'Output', exact: true }).click()
  await expect(page.getByRole('form', { name: 'Steer task' })).toBeVisible()
  await page.clock.pauseAt(new Date(Date.now() + 1000))
  const before = await page.evaluate(() => ({ ...window.outputCommits }))
  for (const name of ['TaskView', 'TaskOutput', 'PatchFiles', 'TaskSteeringComposer']) expect(before[name]).toBeGreaterThan(0)
  for (let burst = 0; burst < 3; burst++) {
    await emit(page, 'review-agent', `Snapshot burst ${burst}`, 'review')
    await expect(rows(page).last()).toContainText(`Snapshot burst ${burst}`)
  }
  const after = await page.evaluate(() => ({ ...window.outputCommits }))
  expect(after.TaskOutput).toBeGreaterThan(before.TaskOutput)
  for (const name of ['TaskView', 'PatchFiles', 'TaskSteeringComposer']) expect(after[name]).toBe(before[name])
  // Header and review actions are owned by TaskView. A real status update must
  // still commit that owner and update both its status and available actions.
  await expect(page.getByRole('button', { name: 'Merge', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    const { useStore } = await import('/src/renderer/src/state/store.ts')
    const task = useStore.getState().tasks.find((task) => task.id === 'review')!
    window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...task, status: 'failed', deliveryStatus: 'agent_failed' } }))
  })
  await expect(page.getByLabel('Task status', { exact: true })).toContainText('Failed')
  await expect(page.getByRole('button', { name: 'Merge', exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => window.outputCommits.TaskView)).toBeGreaterThan(after.TaskView)
})
