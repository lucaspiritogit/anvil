import { expect, test, type Page } from '@playwright/test'

const output = (page: Page) => page.getByRole('log', { name: 'Task output' })
const rows = (page: Page) => output(page).locator('[data-event-id]')
const history = (page: Page) => page.getByRole('navigation', { name: 'Output history' })
const atBottom = (page: Page) => output(page).evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 2)
const settled = (page: Page) => expect(output(page)).toHaveAttribute('aria-busy', 'false')
const eventTotal = (page: Page, count: number) => expect(history(page)).toContainText(`${count} events`)

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

test('loads earlier events on demand and preserves the reader position', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&historySize=4500')
  await eventTotal(page, 500)
  expect(await rows(page).count()).toBeLessThan(100)
  await expect.poll(() => atBottom(page)).toBe(true)
  await scrollTo(page, 0)
  const first = output(page).locator('[data-event-id="history-4001"]')
  await expect(first).toBeVisible()
  const rowTop = async () => first.evaluate((el) => el.getBoundingClientRect().top)
  const before = await rowTop()
  await page.getByRole('button', { name: 'Load earlier events' }).click()
  await eventTotal(page, 1000)
  expect(await rows(page).count()).toBeLessThan(100)
  // scrollTop rounds fractional CSS pixels in Chromium.
  await expect.poll(async () => Math.abs((await rowTop()) - before)).toBeLessThanOrEqual(1)
})

test('follows the live tail, preserves a reader through snapshots, and returns to the tail on re-entry', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&historySize=600&steering=1&running=1')
  await eventTotal(page, 500)
  await emit(page, 'live', 'Live tail')
  await expect(output(page).locator('[data-event-id="live"]')).toHaveText(/Live tail/)
  await expect.poll(() => atBottom(page)).toBe(true)
  await scrollTo(page, 700)
  const before = await anchor(page)
  await emit(page, 'history-101', 'Updated snapshot\nsecond line\nthird line')
  await eventTotal(page, 501)
  await expectAnchor(page, before)
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await expect(page.getByRole('form', { name: 'Steer task' })).toBeVisible()
  await emit(page, 'live-2', 'Output while changes are open')
  await page.getByRole('tab', { name: 'Output', exact: true }).click()
  await expect(output(page).locator('[data-event-id="live-2"]')).toContainText('Output while changes are open')
  await expect.poll(() => atBottom(page)).toBe(true)
  await emit(page, 'live-3', 'Persisted while browsing history')
  await eventTotal(page, 503)
  await expect(output(page).locator('[data-event-id="live-3"]')).toContainText('Persisted while browsing history')
  await expect.poll(() => atBottom(page)).toBe(true)
  await expect(page.getByRole('status', { name: 'Agent activity' })).toContainText('Writing a response')
})

test('re-entering from an older history window loads the latest page and settles at the bottom', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&historySize=4500&steering=1&running=1')
  await eventTotal(page, 500)
  await expect.poll(() => atBottom(page)).toBe(true)
  await scrollTo(page, 0)
  await page.getByRole('button', { name: 'Load earlier events' }).click()
  await eventTotal(page, 1000)
  await expect(history(page)).toContainText('History')
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await page.getByRole('tab', { name: 'Output', exact: true }).click()
  await eventTotal(page, 500)
  await expect(history(page)).toContainText('Latest')
  await expect.poll(() => atBottom(page)).toBe(true)
  await expect(output(page).locator('[data-event-id="history-4500"]')).toBeVisible()
  expect(await page.evaluate(() => window.outputTest.requests.at(-1))).toEqual({ taskId: 'output', limit: 500 })
})

test('initial and latest loading failures retain output and retry the failed request', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&historySize=600&outputFailure=1')
  await expect(page.getByRole('alert')).toContainText('Output history unavailable')
  await expect(output(page)).not.toContainText('No output recorded.')
  await page.getByRole('button', { name: 'Retry output' }).click()
  await eventTotal(page, 500)
  await scrollTo(page, 0)
  const count = await page.evaluate(async () => {
    const { useStore } = await import('/apps/web/src/state/store.ts')
    return useStore.getState().eventsByTask.output.length
  })
  await page.evaluate(() => { window.outputTest.hold = true })
  await page.getByRole('button', { name: 'Jump to latest', exact: true }).click()
  await expect(output(page)).toHaveAttribute('aria-busy', 'true')
  await expect(history(page)).toContainText('Loading output…')
  await page.evaluate(() => { window.outputTest.hold = false; window.outputTest.release(true) })
  await expect(page.getByRole('alert')).toContainText('Output history unavailable')
  await eventTotal(page, count)
  const failed = await page.evaluate(() => window.outputTest.requests.at(-1))
  await page.getByRole('button', { name: 'Retry output' }).click()
  await settled(page)
  await expect(page.getByRole('alert')).toHaveCount(0)
  expect(await page.evaluate(() => window.outputTest.requests.at(-1))).toEqual(failed)
  await expect.poll(() => atBottom(page)).toBe(true)
})

test('task, Home and project navigation evict history and reopen fresh at the tail', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&historySize=4500&steering=1&running=1')
  await eventTotal(page, 500)
  await page.evaluate(async () => {
    const { useStore } = await import('/apps/web/src/state/store.ts')
    await useStore.getState().openTask('running')
  })
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Build streaming support')
  await eventTotal(page, 500)
  await expect.poll(() => atBottom(page)).toBe(true)
  await emit(page, 'background', 'Background task persisted', 'output')
  expect(await page.evaluate(async () => {
    const { useStore } = await import('/apps/web/src/state/store.ts')
    return Object.keys(useStore.getState().eventsByTask)
  })).toEqual(['running'])
  for (const destination of ['home', 'project']) {
    await page.evaluate(async (destination) => {
      const { useStore } = await import('/apps/web/src/state/store.ts')
      if (destination === 'home') useStore.getState().showHome()
      else useStore.getState().selectProject('project-0')
    }, destination)
    expect(await page.evaluate(async () => {
      const { useStore } = await import('/apps/web/src/state/store.ts')
      const { eventsByTask, taskEventHistory } = useStore.getState()
      return { eventsByTask, taskEventHistory }
    })).toEqual({ eventsByTask: {}, taskEventHistory: null })
    await page.evaluate(async () => {
      const { useStore } = await import('/apps/web/src/state/store.ts')
      await useStore.getState().openTask('output')
    })
    await eventTotal(page, 500)
    await expect(output(page).locator('[data-event-id="background"]')).toContainText('Background task persisted')
    await expect.poll(() => atBottom(page)).toBe(true)
  }
})

test('prompt, tool rows, delivery messages, empty output and activity retain accessible rendering', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&tools=1&longPrompt=1&steering=1&running=1')
  await eventTotal(page, 2)
  await scrollTo(page, 0)
  const prompt = page.getByRole('region', { name: 'Task prompt' })
  await prompt.getByRole('button', { name: 'Show more' }).click()
  await expect(prompt.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true')
  await prompt.getByRole('button', { name: 'Show less' }).click()
  const tool = output(page).locator('[data-output-category="tool_use"]')
  await tool.getByRole('button', { name: 'Expand event' }).first().click()
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

test('filters events by category chip and text query', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&tools=1&steering=1&running=1')
  await eventTotal(page, 2)
  await emit(page, 'agent-message', 'A message from the agent')
  await emit(page, 'agent-error', 'Something failed', 'output', 'error')
  const filters = page.getByRole('toolbar', { name: 'Output filters' })
  await filters.getByRole('button', { name: 'error', exact: true }).click()
  await expect(output(page).locator('[data-event-id="agent-error"]')).toBeHidden()
  await expect(output(page).locator('[data-event-id="agent-message"]')).toBeVisible()
  await filters.getByRole('button', { name: 'error', exact: true }).click()
  await expect(output(page).locator('[data-event-id="agent-error"]')).toBeVisible()
  await filters.getByRole('textbox', { name: 'Filter output' }).fill('Something')
  await expect(output(page).locator('[data-event-id="agent-message"]')).toBeHidden()
  await expect(output(page).locator('[data-event-id="agent-error"]')).toBeVisible()
  await filters.getByRole('textbox', { name: 'Filter output' }).fill('')
  await expect(output(page).locator('[data-event-id="agent-message"]')).toBeVisible()
})

test('filters MCP and ordinary tool calls independently with paired results', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&emptyOutput=1')
  await eventTotal(page, 0)
  await emit(page, 'mcp-use', 'anvil_issue_tracker/anvil_get_plan\n{}', 'output', 'tool_use')
  await emit(page, 'mcp-result', 'MCP result', 'output', 'tool_result')
  await emit(page, 'ordinary-use', 'Shell\npwd', 'output', 'tool_use')
  await emit(page, 'ordinary-result', 'Shell result', 'output', 'tool_result')
  await eventTotal(page, 4)

  const filters = page.getByRole('toolbar', { name: 'Output filters' })
  const mcp = filters.getByRole('button', { name: 'mcp_tool', exact: true })
  const ordinary = filters.getByRole('button', { name: 'tool_use', exact: true })
  const mcpCall = output(page).locator('[data-event-id="mcp-use"]')
  const mcpResult = output(page).locator('[data-event-id="mcp-result"]')
  const ordinaryCall = output(page).locator('[data-event-id="ordinary-use"]')
  const ordinaryResult = output(page).locator('[data-event-id="ordinary-result"]')
  await expect(mcp).toHaveAttribute('aria-pressed', 'true')
  await expect(ordinary).toHaveAttribute('aria-pressed', 'true')
  await expect(mcp).toContainText('1')
  await expect(ordinary).toContainText('1')
  await expect(mcpCall).toHaveAttribute('data-output-category', 'mcp_tool')
  await expect(mcpResult).toBeVisible()
  await expect(ordinaryResult).toBeVisible()

  await mcp.click()
  await expect(mcp).toHaveAttribute('aria-pressed', 'false')
  await expect(mcpCall).toBeHidden()
  await expect(mcpResult).toBeHidden()
  await expect(ordinaryCall).toBeVisible()
  await expect(ordinaryResult).toBeVisible()
  await expect(history(page)).toContainText('2 of 4 events')

  await ordinary.click()
  await expect(ordinaryCall).toBeHidden()
  await expect(ordinaryResult).toBeHidden()
  await expect(history(page)).toContainText('0 of 4 events')
  await expect(output(page)).toContainText('No events match the current filters.')

  await mcp.click()
  await expect(mcpCall).toBeVisible()
  await expect(mcpResult).toBeVisible()
  await expect(ordinaryCall).toBeHidden()
  await expect(history(page)).toContainText('2 of 4 events')
  await expect(output(page)).not.toContainText('No events match the current filters.')

  await ordinary.click()
  await expect(history(page)).toContainText('4 events')
  await filters.getByRole('button', { name: 'tool_result', exact: true }).click()
  await expect(mcpCall).toBeVisible()
  await expect(ordinaryCall).toBeVisible()
  await expect(mcpResult).toBeHidden()
  await expect(ordinaryResult).toBeHidden()
  await expect(history(page)).toContainText('2 of 4 events')
})

test('copies a single event from its row copy button', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/tests/e2e/fixture/?scenario=output&tools=1')
  await eventTotal(page, 2)
  await emit(page, 'agent-message', 'A message from the agent')
  const message = output(page).locator('[data-event-id="agent-message"]')
  await message.hover()
  await message.getByRole('button', { name: 'Copy event' }).click()
  await expect(message.getByRole('button', { name: 'Copied' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('A message from the agent')
  const result = output(page).locator('[data-output-category="tool_result"]')
  await result.hover()
  await result.getByRole('button', { name: 'Copy event' }).click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('/tmp/project\nfirst.ts\nsecond.ts')
})

test('reports new events in a pill while scrolled up and returns to the tail', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&historySize=600&steering=1&running=1')
  await eventTotal(page, 500)
  await scrollTo(page, 0)
  await emit(page, 'live-1', 'First new event')
  await emit(page, 'live-2', 'Second new event')
  const pill = page.getByRole('button', { name: /new events/ })
  await expect(pill).toHaveText('↓ 2 new events')
  await pill.click()
  await expect.poll(() => atBottom(page)).toBe(true)
  await expect(pill).toHaveCount(0)
  await expect(output(page).locator('[data-event-id="live-2"]')).toContainText('Second new event')
})

test('event-only bursts commit output without TaskView, review/header owner, diff or composer commits', async ({ page }) => {
  // The succeeded review task has no elapsed-time interval. Freeze the clock as
  // well so task/issue polling cannot enter the measurement window.
  await page.clock.install()
  await page.goto('/tests/e2e/fixture/?scenario=review&renderProbe=1')
  await eventTotal(page, 2)
  await page.getByRole('tab', { name: /^Changes/ }).click()
  await expect(page.getByRole('region', { name: 'src/sidebar.ts' })).toBeVisible()
  const hiddenBefore = await page.evaluate(() => ({ ...window.outputCommits }))
  await emit(page, 'review-agent', 'Snapshot while output is hidden', 'review')
  await page.waitForTimeout(50)
  const hiddenAfter = await page.evaluate(() => ({ ...window.outputCommits }))
  expect(hiddenAfter.TaskOutput).toBe(hiddenBefore.TaskOutput)
  await page.getByRole('tab', { name: 'Output', exact: true }).click()
  await expect(output(page).locator('[data-event-id="review-agent"]')).toContainText('Snapshot while output is hidden')
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
  await expect(page.getByRole('button', { name: 'Merge task', exact: true })).toBeVisible()
  await page.evaluate(async () => {
    const { useStore } = await import('/apps/web/src/state/store.ts')
    const task = useStore.getState().tasks.find((task) => task.id === 'review')!
    window.dispatchEvent(new CustomEvent('fixture:task-updated', { detail: { ...task, status: 'failed', deliveryStatus: 'agent_failed' } }))
  })
  await expect(page.getByLabel('Task status', { exact: true })).toContainText('Failed')
  await expect(page.getByRole('button', { name: 'Merge task', exact: true })).toHaveCount(0)
  expect(await page.evaluate(() => window.outputCommits.TaskView)).toBeGreaterThan(after.TaskView)
})
