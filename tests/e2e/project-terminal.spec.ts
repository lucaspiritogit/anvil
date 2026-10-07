import { expect, test, type Page } from '@playwright/test'

async function selectProject(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Select project: / }).first().click()
}

for (const [platform, modifier] of [['darwin', 'Meta'], ['linux', 'Control']] as const) {
  test(`${modifier}+T and close hide the project terminal without replacing its session`, async ({ page }) => {
    await page.goto(`/tests/e2e/fixture/?platform=${platform}`)
    await expect(page.getByRole('textbox', { name: 'Task prompt' })).toBeVisible()
    await selectProject(page)
  await selectProject(page)
    await page.keyboard.press(`${modifier}+t`)
    const panel = page.getByRole('region', { name: 'Project terminal', exact: true })
    await expect(panel).toBeVisible()
    await expect(panel.locator('canvas')).toBeVisible()
    const sessionId = await panel.locator('[data-terminal-session]').getAttribute('data-terminal-session')
    if (!sessionId) throw new Error('Project terminal session was not rendered')
    await page.keyboard.press(`${modifier}+t`)
    await expect(panel).toBeHidden()
    await page.keyboard.press(`${modifier}+t`)
    await expect(panel).toBeVisible()
    await expect(panel.locator(`[data-terminal-session="${sessionId}"]`)).toHaveCount(1)
    expect(await page.evaluate(() => window.terminalTest.creates.map((call) => call.sessionId))).toEqual([sessionId])
    expect(await page.evaluate(() => window.terminalTest.attaches)).toEqual([sessionId])
    await page.getByRole('button', { name: 'Close project terminal' }).click()
    await expect(panel).toBeHidden()
    await page.keyboard.press(`${modifier}+t`)
    await expect(panel).toBeVisible()
    await expect(panel.locator(`[data-terminal-session="${sessionId}"]`)).toHaveCount(1)
    expect(await page.evaluate(() => window.terminalTest.creates.map((call) => call.sessionId))).toEqual([sessionId])
    expect(await page.evaluate(() => window.terminalTest.attaches)).toEqual([sessionId])
    expect(await page.evaluate(() => window.terminalTest.disposes)).toEqual([])
  })
}

test('opening Settings disposes the project terminal and returning creates a clean session', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/')
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toBeVisible()
  await selectProject(page)
  await page.keyboard.press('Control+t')
  const panel = page.getByRole('region', { name: 'Project terminal', exact: true })
  await expect(panel.locator('canvas')).toBeVisible()
  const firstSessionId = await panel.locator('[data-terminal-session]').getAttribute('data-terminal-session')
  if (!firstSessionId) throw new Error('First project terminal session was not rendered')

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.locator(`[data-terminal-session="${firstSessionId}"]`)).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => window.terminalTest.disposes)).toEqual([firstSessionId])
  await page.getByRole('button', { name: 'Back to workspace', exact: true }).click()
  await expect(panel).toHaveCount(0)

  await page.keyboard.press('Control+t')
  await expect(panel.locator('canvas')).toBeVisible()
  const secondSessionId = await panel.locator('[data-terminal-session]').getAttribute('data-terminal-session')
  if (!secondSessionId) throw new Error('Second project terminal session was not rendered')
  expect(secondSessionId).not.toBe(firstSessionId)
  expect(await page.evaluate(() => window.terminalTest.creates.map((call) => call.sessionId))).toEqual([firstSessionId, secondSessionId])
  expect(await page.evaluate(() => window.terminalTest.attaches)).toEqual([firstSessionId, secondSessionId])
})

test('terminal launch failure is visible', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/')
  await page.evaluate(() => { window.anvil.terminals.create = async () => { throw new Error('Shell unavailable') } })
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toBeVisible()
  await selectProject(page)
  await page.keyboard.press('Control+t')
  await expect(page.getByRole('alert')).toContainText('Could not open the project terminal')
})

test('terminal opens as a full-width bottom dock that keeps the composer visible', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/tests/e2e/fixture/')
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toBeVisible()
  await selectProject(page)
  await page.keyboard.press('Control+t')
  const panel = page.getByRole('region', { name: 'Project terminal', exact: true })
  await expect(panel.locator('canvas')).toBeVisible()
  const box = (await panel.boundingBox())!
  const main = (await page.locator('main').first().boundingBox())!
  expect(Math.round(box.y + box.height)).toBe(720)
  expect(box.width).toBeGreaterThanOrEqual(main.width)
  expect(box.height).toBeGreaterThanOrEqual(120)
  expect(box.height).toBeLessThanOrEqual(720 * 0.7)
  await expect(panel.getByRole('tab', { name: /Workbench|Anvil|project/ })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toBeInViewport()
  await page.getByRole('button', { name: 'Close project terminal' }).click()
  await expect(page.getByRole('button', { name: 'Open project terminal' })).toContainText('1 session')
  await page.keyboard.press('Control+Backquote')
  await expect(panel).toBeVisible()
})
