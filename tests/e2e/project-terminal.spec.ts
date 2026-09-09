import { expect, test } from '@playwright/test'

for (const [platform, modifier] of [['darwin', 'Meta'], ['linux', 'Control']] as const) {
  test(`${modifier}+T opens the project shell from composer, tasks and settings and preserves sessions`, async ({ page }, testInfo) => {
    await page.goto(`/tests/e2e/fixture/?platform=${platform}`)
    await page.evaluate(() => {
      const sessions = new Set<string>()
      const calls: string[] = []
      Object.assign(window, { terminalCalls: calls })
      window.anvil.terminal.ensure = async ({ projectId }) => {
        sessions.add(projectId)
        calls.push(`ensure:${projectId}`)
        return { data: `project=${projectId}\r\n$ `, sequence: 0 }
      }
      window.anvil.terminal.write = (projectId, data) => calls.push(`write:${projectId}:${data}`)
    })
    const prompt = page.getByRole('textbox', { name: 'Task prompt' })
    await prompt.fill('Keep composing')
    await page.keyboard.press(`${modifier}+t`)
    const dialog = page.getByRole('dialog', { name: 'Project terminal', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('heading', { name: 'Anvil terminal' })).toBeVisible()
    await expect(dialog.getByText('/tmp/anvil', { exact: true })).toBeVisible()
    const bounds = (await dialog.boundingBox())!
    expect(bounds.width).toBeGreaterThan(page.viewportSize()!.width * 0.9)
    expect(bounds.height).toBeGreaterThan(page.viewportSize()!.height * 0.9)
    const shell = dialog.locator('.xterm-helper-textarea:visible')
    await expect(shell).toBeFocused()
    await shell.pressSequentially('pwd')
    await shell.press('Enter')
    await page.screenshot({ path: testInfo.outputPath(`project-terminal-${platform}.png`) })
    await page.keyboard.press(`${modifier}+t`)
    await expect(dialog).toBeHidden()
    await expect(prompt).toBeFocused()
    await expect(prompt).toHaveValue('Keep composing')
    await page.keyboard.press(`${modifier}+t`)
    await expect(shell).toBeFocused()
    expect(await page.evaluate(() => (window as unknown as { terminalCalls: string[] }).terminalCalls.filter((call) => call.startsWith('ensure:')))).toEqual(['ensure:project-0'])
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Open task: Layout test task', exact: true }).click()
    await expect(page.getByRole('tab', { name: 'Terminal', exact: true })).toHaveCount(0)
    await page.keyboard.press(`${modifier}+t`)
    await expect(dialog.getByRole('heading', { name: 'Workbench terminal' })).toBeVisible()
    await expect(dialog.getByText('/tmp/workbench', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Close terminal', exact: true }).click()
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.keyboard.press(`${modifier}+t`)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('heading', { name: 'Workbench terminal' })).toBeVisible()
    const calls = await page.evaluate(() => (window as unknown as { terminalCalls: string[] }).terminalCalls)
    expect(calls.filter((call) => call.startsWith('ensure:'))).toEqual(['ensure:project-0', 'ensure:project-1'])
    expect(calls.some((call) => call.includes('\u0014'))).toBe(false)
  })
}

test('terminal startup failure offers a restart and Escape returns to the overview', async ({ page }) => {
  await page.goto('/tests/e2e/fixture/')
  await page.evaluate(() => { window.anvil.terminal.ensure = async () => { throw new Error('Shell unavailable') } })
  await page.keyboard.press('Control+t')
  const dialog = page.getByRole('dialog', { name: 'Project terminal', exact: true })
  await expect(dialog.getByRole('button', { name: 'Restart shell', exact: true })).toBeVisible()
  await page.evaluate(() => { window.anvil.terminal.ensure = async () => ({ data: '$ ', sequence: 0 }) })
  await dialog.getByRole('button', { name: 'Restart shell', exact: true }).click()
  await expect(dialog.locator('.xterm-helper-textarea')).toBeFocused()
  await expect(dialog.getByRole('button', { name: 'Restart shell', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toBeVisible()
})
