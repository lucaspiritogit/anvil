import { expect, test, type Page } from '@playwright/test'

async function captureSteering(page: Page): Promise<void> {
  await page.evaluate(() => {
    const requests: unknown[] = []
    Object.assign(window, { steeringRequests: requests })
    window.addEventListener('fixture:steering', (event) => requests.push((event as CustomEvent).detail))
  })
}

for (const running of [false, true]) {
  test(`compact composer ${running ? 'steers an active turn' : 'continues a finished task'}`, async ({ page }) => {
    await page.goto(`/tests/e2e/fixture/?scenario=output&steering=1${running ? '&running=1' : ''}`)
    const composer = page.getByRole('form', { name: 'Steer task' })
    const input = composer.getByRole('textbox', { name: 'Message to agent' })
    await expect(input).toBeEnabled()
    await expect(input).toHaveAttribute('placeholder', running ? 'Steer this task...' : 'Continue this task...')
    await expect(composer.getByRole('combobox')).toHaveCount(0)
    await expect(composer.getByText(/thinking|task-model|Codex/)).toHaveCount(0)
    const outputBounds = await page.getByRole('log').boundingBox()
    const composerBounds = await composer.boundingBox()
    expect(composerBounds!.y).toBeGreaterThanOrEqual(outputBounds!.y + outputBounds!.height - 1)
    await captureSteering(page)
    await input.fill('  Validate the empty state too  ')
    await input.press('Control+Enter')
    await expect(composer.getByRole('button', { name: 'Sending...' })).toBeDisabled()
    await expect(input).toHaveValue('')
    const requests = await page.evaluate(() => (window as unknown as { steeringRequests: unknown[] }).steeringRequests)
    expect(requests).toEqual([{ taskId: 'output', message: 'Validate the empty state too' }])
    const task = await page.evaluate(async () => (await window.anvil.tasks.list()).find((task) => task.id === 'output'))
    expect(task?.sessionId).toBe('latest-session')
    expect(task?.model).toBe('task-model')
    expect(task?.prompt).toBe('Layout test task')
    await expect(page.getByRole('heading', { name: 'Layout test task' })).toBeVisible()
  })
}

test('agents without live steering still have a follow-up composer', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&steering=1&unsupported=1')
  const composer = page.getByRole('form', { name: 'Steer task' })
  await expect(composer).toBeVisible()
  await expect(composer.getByRole('textbox')).toBeEnabled()
  await composer.getByRole('textbox').fill('Resume the work')
  await composer.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(composer.getByRole('textbox')).toHaveValue('')
  await expect(composer.getByRole('textbox')).toBeDisabled()
  await expect(composer.getByRole('textbox')).toHaveAttribute('placeholder', /after it stops/)
})

test('sending waits for a session and rejects empty messages', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&steering=1&noSession=1&running=1')
  await expect(page.getByRole('textbox', { name: 'Message to agent' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await page.goto('/tests/e2e/fixture/?scenario=output&steering=1')
  const input = page.getByRole('textbox', { name: 'Message to agent' })
  await input.fill('   ')
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
})

test('rejected steering preserves the draft and allows retry', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&steering=1&steerFailure=1')
  const input = page.getByRole('textbox', { name: 'Message to agent' })
  await input.fill('Keep this instruction')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('The agent rejected steering')
  await expect(input).toHaveValue('Keep this instruction')
  await expect(input).toBeEnabled()
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
})

for (const viewport of [{ width: 900, height: 500 }, { width: 1100, height: 700 }]) {
  test(`long prompt scrolls below visible statistics at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport)
    await page.goto('/tests/e2e/fixture/?scenario=output&steering=1&longPrompt=1&taskUsage=1')
    const statistics = page.getByRole('group', { name: 'Task statistics' })
    const prompt = page.getByRole('region', { name: 'Task prompt' })
    const composer = page.getByRole('form', { name: 'Steer task' })
    await expect(statistics).toBeInViewport({ ratio: 1 })
    await expect(composer).toBeInViewport({ ratio: 1 })
    for (const label of ['Elapsed', 'Tokens', 'Cost']) await expect(statistics.getByText(label, { exact: true })).toBeVisible()
    const statisticsBounds = (await statistics.boundingBox())!
    const promptBounds = (await prompt.boundingBox())!
    expect(promptBounds.y).toBeGreaterThanOrEqual(statisticsBounds.y + statisticsBounds.height)
    expect(promptBounds.height).toBeGreaterThan(15)
    expect((await page.getByRole('log').boundingBox())!.height).toBeGreaterThan(100)
    expect(await prompt.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    await prompt.hover()
    await page.mouse.wheel(0, 10000)
    await expect.poll(() => prompt.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    expect(await statistics.boundingBox()).toEqual(statisticsBounds)
    await expect(composer.getByRole('textbox')).toBeInViewport({ ratio: 1 })
    await page.screenshot({ path: testInfo.outputPath('task-layout.png') })
  })
}

test('pending task shows its status and accepts a recovery prompt', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/?scenario=output&steering=1&pending=1')
  await expect(page.getByText('Pending', { exact: true }).first()).toBeVisible()
  const input = page.getByRole('textbox', { name: 'Message to agent' })
  await expect(input).toBeEnabled()
  await expect(input).toHaveAttribute('placeholder', 'Help this task continue...')
  await captureSteering(page)
  await input.fill('Fix the already running error')
  await page.screenshot({ path: testInfo.outputPath('pending-task.png') })
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(input).toHaveValue('')
  expect(await page.evaluate(() => (window as unknown as { steeringRequests: unknown[] }).steeringRequests))
    .toEqual([{ taskId: 'output', message: 'Fix the already running error' }])
})
