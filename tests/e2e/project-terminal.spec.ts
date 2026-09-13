import { expect, test } from '@playwright/test'

for (const [platform, modifier] of [['darwin', 'Meta'], ['linux', 'Control']] as const) {
  test(`${modifier}+T toggles the project terminal and close ends the session`, async ({ page }) => {
    await page.goto(`/tests/e2e/fixture/?platform=${platform}`)
    await expect(page.getByRole('textbox', { name: 'Task prompt' })).toBeVisible()
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
    await expect(panel).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => window.terminalTest.disposes)).toEqual([sessionId])
  })
}

test('opening Settings disposes the project terminal and returning creates a clean session', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/')
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toBeVisible()
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
  await page.keyboard.press('Control+t')
  await expect(page.getByRole('alert')).toContainText('Could not open the project terminal')
})
