import { expect, test } from '@playwright/test'

for (const [platform, modifier] of [['darwin', 'Meta'], ['linux', 'Control']] as const) {
  test(`${modifier}+T opens the system terminal from composer, tasks and settings`, async ({ page }) => {
    await page.goto(`/tests/e2e/fixture/?platform=${platform}`)
    await page.evaluate(() => {
      const calls: string[] = []
      Object.assign(window, { terminalCalls: calls })
      window.anvil.projects.openTerminal = async (projectId) => { calls.push(projectId) }
    })
    const calls = () => page.evaluate(() => (window as unknown as { terminalCalls: string[] }).terminalCalls)
    const prompt = page.getByRole('textbox', { name: 'Task prompt' })
    await prompt.fill('Keep composing')
    await page.keyboard.press(`${modifier}+t`)
    await expect.poll(calls).toEqual(['project-0'])
    await expect(prompt).toBeFocused()
    await expect(prompt).toHaveValue('Keep composing')
    await expect(page.getByRole('dialog', { name: 'Project terminal', exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Open task: Layout test task', exact: true }).click()
    await page.keyboard.press(`${modifier}+t`)
    await expect.poll(calls).toEqual(['project-0', 'project-1'])
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.keyboard.press(`${modifier}+t`)
    await expect.poll(calls).toEqual(['project-0', 'project-1', 'project-1'])
    await page.keyboard.down(modifier)
    await page.keyboard.down('t')
    await page.keyboard.down('t')
    await page.keyboard.up('t')
    await page.keyboard.up(modifier)
    await expect.poll(calls).toHaveLength(4)
  })
}

test('terminal launch failure is visible and the shortcut can retry', async ({ page }, testInfo) => {
  await page.goto('/tests/e2e/fixture/')
  await page.evaluate(() => { window.anvil.projects.openTerminal = async () => { throw new Error('Shell unavailable') } })
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toBeVisible()
  await page.keyboard.press('Control+t')
  await expect(page.getByRole('alert')).toContainText('Could not open the system terminal')
  await page.screenshot({ path: testInfo.outputPath('terminal-launch-error.png') })
  await page.evaluate(() => { window.anvil.projects.openTerminal = async () => {} })
  await page.keyboard.press('Control+t')
  await expect(page.getByRole('alert')).toHaveCount(0)
})
