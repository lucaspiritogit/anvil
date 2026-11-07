import { expect, test, type Page } from '@playwright/test'

async function captureSteering(page: Page): Promise<void> {
  await page.evaluate(() => {
    const requests: unknown[] = []
    Object.assign(window, { steeringRequests: requests })
    window.addEventListener('fixture:steering', (event) => requests.push((event as CustomEvent).detail))
  })
}

async function captureQueue(page: Page): Promise<void> {
  await page.evaluate(() => {
    const requests: unknown[] = []
    Object.assign(window, { queueRequests: requests })
    window.addEventListener('fixture:queue', (event) => requests.push((event as CustomEvent).detail))
  })
}

async function steeringRequests(page: Page): Promise<unknown[]> {
  return page.evaluate(() => (window as unknown as { steeringRequests: unknown[] }).steeringRequests)
}

async function expectActionAlignedWithInput(page: Page, actionName: 'Steer message' | 'Stop task'): Promise<void> {
  const composer = page.getByRole('form', { name: 'Steer task' })
  const inputBounds = (await composer.getByRole('textbox', { name: 'Message to agent' }).boundingBox())!
  const actionBounds = (await composer.getByRole('button', { name: actionName }).boundingBox())!
  expect(actionBounds.width).toBeGreaterThan(actionBounds.height)
  expect(actionBounds.width).toBeGreaterThanOrEqual(48)
  expect(actionBounds.height).toBeLessThan(inputBounds.height)
  expect(actionBounds.y).toBeGreaterThanOrEqual(inputBounds.y + inputBounds.height - 1)
  expect(actionBounds.x + actionBounds.width).toBeLessThanOrEqual(inputBounds.x + inputBounds.width)
}

for (const running of [false, true]) {
  test(`compact composer ${running ? 'steers an active turn' : 'continues a finished task'}`, async ({ page }) => {
    await page.goto(`/tests/e2e/fixture/?scenario=output&steering=1${running ? '&running=1' : ''}`)
    const composer = page.getByRole('form', { name: 'Steer task' })
    const input = composer.getByRole('textbox', { name: 'Message to agent' })
    await expect(input).toBeEnabled()
    await expect(input).toHaveAttribute('placeholder', running ? 'Steer the agent… (Alt+Enter queues)' : 'Follow up…')
    await expect(composer.getByRole('combobox')).toHaveCount(0)
    await expect(composer.getByText(/thinking/)).toHaveCount(0)
    const outputBounds = await page.getByRole('log').boundingBox()
    const composerBounds = await composer.boundingBox()
    expect(composerBounds!.y).toBeGreaterThanOrEqual(outputBounds!.y + outputBounds!.height - 1)
    await captureSteering(page)
    await input.fill('  Validate the empty state too  ')
    await input.press('Enter')
    await expect(composer.getByRole('button', { name: running ? 'Steer message' : 'Send message' })).toBeDisabled()
    await expect(input).toHaveValue('')
    expect(await steeringRequests(page)).toEqual([running
      ? { taskId: 'output', message: 'Validate the empty state too', mode: 'steer' }
      : { taskId: 'output', message: 'Validate the empty state too' }])
    const task = await page.evaluate(async () => (await window.anvil.tasks.list()).find((task) => task.id === 'output'))
    expect(task?.sessionId).toBe('latest-session')
    expect(task?.model).toBe('task-model')
    expect(task?.prompt).toBe('Layout test task')
    await expect(page.getByRole('heading', { name: 'Layout test task' })).toBeVisible()
  })
}

test('agents without live steering queue while running', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&steering=1&unsupported=1&running=1')
  const composer = page.getByRole('form', { name: 'Steer task' })
  const input = composer.getByRole('textbox')
  await expect(input).toBeEnabled()
  await captureSteering(page)
  await input.fill('Resume the work')
  await expect(composer.getByRole('button', { name: 'Steer message' })).toHaveCount(0)
  await expect(composer.getByRole('button', { name: 'Queue message' })).toHaveText('↵queue')
  await input.press('Enter')
  await expect(input).toHaveValue('')
  expect(await steeringRequests(page)).toEqual([{ taskId: 'output', message: 'Resume the work', mode: 'queue' }])
  await expect(composer.getByRole('list', { name: 'Queued for after this turn' }).getByRole('button', { name: 'Open queued message: Resume the work' })).toBeVisible()
})

test('running tasks without a session accept input and empty input offers stop', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&steering=1&noSession=1&running=1')
  await expect(page.getByRole('textbox', { name: 'Message to agent' })).toBeEnabled()
  await expect(page.getByRole('form', { name: 'Steer task' }).getByRole('button', { name: 'Stop task' })).toBeEnabled()
  await page.goto('/tests/e2e/fixture/?scenario=output&steering=1')
  const input = page.getByRole('textbox', { name: 'Message to agent' })
  await input.fill('   ')
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled()
})

test('rejected steering preserves the draft and allows retry', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&steering=1&steerFailure=1')
  const input = page.getByRole('textbox', { name: 'Message to agent' })
  await input.fill('Keep this instruction')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.getByRole('alert')).toHaveText('The agent rejected steering')
  await expect(input).toHaveValue('Keep this instruction')
  await expect(input).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled()
})

for (const viewport of [{ width: 640, height: 500 }, { width: 1100, height: 700 }]) {
  test(`steering actions sit in the footer below the input at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    await page.goto('/tests/e2e/fixture/?scenario=output&steering=1&running=1')
    const composer = page.getByRole('form', { name: 'Steer task' })
    const input = composer.getByRole('textbox', { name: 'Message to agent' })
    await expectActionAlignedWithInput(page, 'Stop task')
    await input.fill('Check the action alignment')
    await expectActionAlignedWithInput(page, 'Steer message')
    await expect(composer).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: testInfo.outputPath('steering-action-layout.png') })
  })
}

for (const viewport of [{ width: 900, height: 500 }, { width: 1100, height: 700 }]) {
  test(`long prompt is clamped inside the transcript at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    await page.goto('/tests/e2e/fixture/?scenario=output&steering=1&longPrompt=1&taskUsage=1')
    const statistics = page.getByRole('group', { name: 'Task statistics' })
    const log = page.getByRole('log', { name: 'Task output' })
    const prompt = log.getByRole('region', { name: 'Task prompt' })
    const composer = page.getByRole('form', { name: 'Steer task' })
    await expect(statistics).toBeInViewport({ ratio: 1 })
    await expect(composer).toBeInViewport({ ratio: 1 })
    for (const label of ['Elapsed', 'Tokens', 'Cost']) await expect(statistics.getByText(label, { exact: true })).toBeVisible()
    const statisticsBounds = (await statistics.boundingBox())!
    const logBounds = (await log.boundingBox())!
    expect(logBounds.height).toBeGreaterThan(100)
    // The prompt scrolls with the output rather than reserving its own band.
    await log.hover()
    await page.mouse.wheel(0, -100000)
    await expect(prompt).toBeInViewport()
    const clampedHeight = (await prompt.boundingBox())!.height
    expect(clampedHeight).toBeLessThan(200)
    await expect(prompt.getByRole('button', { name: 'Show less' })).toHaveCount(0)
    await prompt.getByRole('button', { name: 'Show more' }).click()
    expect((await prompt.boundingBox())!.height).toBeGreaterThan(clampedHeight * 3)
    expect(await log.boundingBox()).toEqual(logBounds)
    expect(await statistics.boundingBox()).toEqual(statisticsBounds)
    await expect(composer.getByRole('textbox')).toBeInViewport({ ratio: 1 })
    await prompt.getByRole('button', { name: 'Show less' }).click()
    expect((await prompt.boundingBox())!.height).toBeLessThan(200)
    await page.screenshot({ path: testInfo.outputPath('task-layout.png') })
  })
}

test('pending task shows its queued indicator and accepts a recovery prompt', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&steering=1&pending=1')
  const sidebarTask = page.getByRole('complementary', { name: 'Task sidebar' })
    .getByRole('button', { name: 'Open task: Layout test task', exact: true })
  const queuedIndicator = sidebarTask.getByRole('img', { name: 'Queued', exact: true })
  await expect(sidebarTask.getByText('Queued', { exact: true })).toBeVisible()
  await expect(queuedIndicator).toHaveClass(/text-idle/)
  await expect(queuedIndicator).toHaveText('□')
  const input = page.getByRole('textbox', { name: 'Message to agent' })
  await expect(input).toBeEnabled()
  await expect(input).toHaveAttribute('placeholder', 'Follow up…')
  await captureSteering(page)
  await input.fill('Fix the already running error')
  await page.screenshot({ path: testInfo.outputPath('pending-task.png') })
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(input).toHaveValue('')
  expect(await steeringRequests(page)).toEqual([{ taskId: 'output', message: 'Fix the already running error' }])
})

test('alt+enter and the queue button queue while running', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&steering=1&running=1')
  const composer = page.getByRole('form', { name: 'Steer task' })
  const input = composer.getByRole('textbox', { name: 'Message to agent' })
  const queueButton = composer.getByRole('button', { name: 'Queue message' })
  await expect(queueButton).toBeDisabled()
  await captureSteering(page)
  await input.fill('After this, add tests')
  await input.press('Alt+Enter')
  await expect(input).toHaveValue('')
  await input.fill('Then update docs')
  await queueButton.click()
  await expect(input).toHaveValue('')
  expect(await steeringRequests(page)).toEqual([
    { taskId: 'output', message: 'After this, add tests', mode: 'queue' },
    { taskId: 'output', message: 'Then update docs', mode: 'queue' }
  ])
  const chips = composer.getByRole('list', { name: 'Queued for after this turn' })
  await expect(chips.getByRole('button', { name: /^Open queued message/ })).toHaveText(['After this, add tests', 'Then update docs'])
})

test('queued chips open, edit, steer now, and remove', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&steering=1&running=1&queued=1')
  const composer = page.getByRole('form', { name: 'Steer task' })
  const chips = composer.getByRole('list', { name: 'Queued for after this turn' })
  const first = 'Also update the README with the new keyboard shortcuts once the tests pass'
  await expect(chips.getByRole('button', { name: /^Open queued message/ })).toHaveCount(2)
  await captureQueue(page)
  await chips.getByRole('button', { name: `Open queued message: ${first}` }).click()
  const detail = composer.getByRole('group', { name: 'Queued message' })
  await expect(detail).toContainText(first)
  await expect(detail).toContainText('#1 in the queue')
  await page.screenshot({ path: testInfo.outputPath('queued-chips.png') })
  await detail.getByRole('button', { name: 'edit' }).click()
  const editor = detail.getByRole('textbox', { name: 'Edit queued message' })
  await expect(editor).toHaveValue(first)
  await editor.fill('Update the README')
  await detail.getByRole('button', { name: 'save' }).click()
  await expect(detail).toHaveCount(0)
  await expect(chips.getByRole('button', { name: 'Open queued message: Update the README' })).toBeVisible()
  await chips.getByRole('button', { name: 'Steer now: Update the README' }).click()
  await expect(chips.getByRole('button', { name: 'Open queued message: Update the README' })).toHaveCount(0)
  await chips.getByRole('button', { name: 'Remove queued message: Run the e2e suite' }).click()
  await expect(composer.getByRole('region', { name: 'Queued messages' })).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as { queueRequests: unknown[] }).queueRequests)).toEqual([
    { action: 'edit', taskId: 'output', id: 'queued-1', message: 'Update the README' },
    { action: 'steer', taskId: 'output', id: 'queued-1' },
    { action: 'remove', taskId: 'output', id: 'queued-2' }
  ])
})

test('queued chips hide steer now once the task stops', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&steering=1&queued=1')
  const chips = page.getByRole('list', { name: 'Queued for after this turn' })
  await expect(chips.getByRole('button', { name: /^Remove queued message/ })).toHaveCount(2)
  await expect(chips.getByRole('button', { name: /^Steer now/ })).toHaveCount(0)
})
