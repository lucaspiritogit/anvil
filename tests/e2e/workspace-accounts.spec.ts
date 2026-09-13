import { expect, test, type Page } from '@playwright/test'

async function openAccounts(page: Page, query = 'workspaces'): Promise<void> {
  await page.goto(`/tests/e2e/fixture/?${query}`)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Providers', exact: true }).click()
}

const card = (page: Page, provider = 'Codex', workspace = 'Default') => page.getByRole('region', { name: `${provider} account for ${workspace}`, exact: true })

async function renderedTerminalSession(page: Page, provider: 'Codex' | 'OpenCode'): Promise<string> {
  const terminal = card(page, provider).locator('[data-terminal-session]')
  await expect(terminal.locator('canvas')).toBeVisible()
  const sessionId = await terminal.getAttribute('data-terminal-session')
  if (!sessionId) throw new Error(`${provider} terminal session was not rendered`)
  return sessionId
}

async function openFreshProjectTerminal(page: Page, obsoleteSessionIds: string[]): Promise<string> {
  await page.getByRole('button', { name: 'Back to workspace', exact: true }).click()
  await page.keyboard.press('Control+t')
  const panel = page.getByRole('region', { name: 'Project terminal', exact: true })
  await expect(panel.locator('canvas')).toBeVisible()
  const sessionId = await panel.locator('[data-terminal-session]').getAttribute('data-terminal-session')
  if (!sessionId) throw new Error('Project terminal session was not rendered')
  for (const obsoleteSessionId of obsoleteSessionIds) {
    await expect(page.locator(`[data-terminal-session="${obsoleteSessionId}"]`)).toHaveCount(0)
  }
  const calls = await page.evaluate(() => structuredClone(window.terminalTest))
  expect(calls.creates.map((call) => call.sessionId)).toEqual([sessionId])
  expect(calls.attaches.filter((attached) => attached.startsWith('project-'))).toEqual([sessionId])
  return sessionId
}

async function complete(page: Page, workspaceId = 'default', success = true): Promise<void> {
  await page.evaluate(({ workspaceId, success }) => window.dispatchEvent(new CustomEvent('fixture:account-complete', {
    detail: { workspaceId, agentId: 'codex', success }
  })), { workspaceId, success })
}

test('workspace API key connect, redacted failure, retry and disconnect apply immediately', async ({ page }, testInfo) => {
  await openAccounts(page)
  const codex = card(page)
  await expect(codex.getByText('Signed out', { exact: true })).toBeVisible()
  await codex.getByLabel('Codex account type for Default').selectOption('apiKey')
  const key = codex.getByLabel('Codex API key for Default')
  await expect(key).toHaveAttribute('type', 'password')
  await key.fill('fixture-fail')
  await codex.getByRole('button', { name: 'Connect Codex for Default', exact: true }).click()
  await expect(codex.getByText('Account operation failed. Retry the connection.')).toBeVisible()
  await expect(key).toHaveValue('')
  await key.fill('sk-fixture-never-persist')
  await codex.getByRole('button', { name: 'Connect Codex for Default', exact: true }).click()
  await expect(codex.getByRole('status')).toHaveText('API key')
  await expect(key).toHaveValue('')
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('sk-fixture-never-persist')
  await page.screenshot({ path: testInfo.outputPath('workspace-accounts.png') })
  await codex.getByRole('button', { name: 'Disconnect Codex for Default', exact: true }).click()
  await expect(codex.getByRole('status')).toHaveText('Signed out')
})

test('subscription stays with its workspace through switches and can be cancelled or retried', async ({ page }) => {
  await openAccounts(page)
  await card(page).getByRole('button', { name: 'Connect Codex for Default', exact: true }).click()
  await expect(card(page).getByRole('button', { name: 'Cancel Codex for Default' })).toBeVisible()
  await page.getByRole('button', { name: 'Create test workspace' }).click()
  const navigation = page.getByRole('navigation', { name: 'Settings sections' })
  await navigation.getByRole('button', { name: 'Providers', exact: true }).click()
  await expect(card(page, 'Codex', 'Work').getByRole('status')).toHaveText('Signed out')
  await complete(page)
  await expect(card(page, 'Codex', 'Work').getByRole('status')).toHaveText('Signed out')
  await page.getByLabel('Test workspace', { exact: true }).selectOption('default')
  await navigation.getByRole('button', { name: 'Providers', exact: true }).click()
  await expect(card(page).getByRole('status')).toContainText('fixture@example.test')
  await card(page).getByRole('button', { name: 'Connect Codex for Default', exact: true }).click()
  await card(page).getByRole('button', { name: 'Cancel Codex for Default', exact: true }).click()
  await expect(card(page).getByRole('status')).toHaveText('Connection cancelled.')
  await complete(page)
  await expect(card(page).getByRole('status')).toHaveText('Connection cancelled.')
  await card(page).getByRole('button', { name: 'Connect Codex for Default', exact: true }).click()
  await complete(page, 'default', false)
  await expect(card(page).getByRole('status')).toContainText('Sign-in failed')
})

for (const method of ['api', 'subscription']) {
  test(`OpenCode native ${method} sign-in uses an in-app terminal and can be cancelled`, async ({ page }, testInfo) => {
    await openAccounts(page)
    const opencode = card(page, 'OpenCode')
    await opencode.getByRole('button', { name: 'Connect OpenCode for Default', exact: true }).click()
    const firstSessionId = await renderedTerminalSession(page, 'OpenCode')
    await expect(opencode.getByText('Complete sign-in or sign-out in the terminal panel.', { exact: false })).toBeVisible()
    await expect(opencode.getByRole('button', { name: 'Connect OpenCode for Default', exact: true })).toBeDisabled()
    await page.screenshot({ path: testInfo.outputPath(`opencode-terminal-${method}.png`) })
    await page.evaluate((method) => window.dispatchEvent(new CustomEvent('fixture:account-complete', {
      detail: { workspaceId: 'default', agentId: 'opencode', success: true, method }
    })), method)
    await expect(opencode.getByRole('status')).toHaveText(method === 'api' ? 'OpenAI: API key' : 'OpenAI: subscription')
    await expect(page.locator(`[data-terminal-session="${firstSessionId}"]`)).toHaveCount(0)
    await expect(opencode.getByRole('button', { name: 'Cancel OpenCode for Default', exact: true })).toHaveCount(0)
    await opencode.getByRole('button', { name: 'Connect OpenCode for Default', exact: true }).click()
    const secondSessionId = await renderedTerminalSession(page, 'OpenCode')
    expect(secondSessionId).not.toBe(firstSessionId)
    await expect(page.locator(`[data-terminal-session="${firstSessionId}"]`)).toHaveCount(0)
    await opencode.getByRole('button', { name: 'Cancel OpenCode for Default', exact: true }).click()
    await expect(opencode.getByRole('status')).toHaveText('Connection cancelled.')
    await expect(page.locator(`[data-terminal-session="${secondSessionId}"]`)).toHaveCount(0)
    await openFreshProjectTerminal(page, [firstSessionId, secondSessionId])
  })
}

test('Codex ChatGPT device-code sign-in shows the terminal guide and can be cancelled', async ({ page }, testInfo) => {
  await openAccounts(page)
  const codex = card(page)
  await codex.getByLabel('ChatGPT sign-in flow for Default').selectOption('deviceCode')
  await expect(codex.getByText('Open the verification link from any device and enter the one-time code in the terminal panel. This signs Codex in with your ChatGPT subscription.')).toBeVisible()
  await codex.getByRole('button', { name: 'Connect Codex for Default', exact: true }).click()
  const firstSessionId = await renderedTerminalSession(page, 'Codex')
  await expect(codex.getByText('enter the one-time code', { exact: false })).toBeVisible()
  await expect(codex.getByRole('button', { name: 'Connect Codex for Default', exact: true })).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('codex-device-auth-terminal.png') })
  await complete(page)
  await expect(codex.getByRole('status')).toHaveText('ChatGPT: fixture@example.test (plus)')
  await expect(page.locator(`[data-terminal-session="${firstSessionId}"]`)).toHaveCount(0)
  await codex.getByRole('button', { name: 'Connect Codex for Default', exact: true }).click()
  const secondSessionId = await renderedTerminalSession(page, 'Codex')
  expect(secondSessionId).not.toBe(firstSessionId)
  await expect(page.locator(`[data-terminal-session="${firstSessionId}"]`)).toHaveCount(0)
  await codex.getByRole('button', { name: 'Cancel Codex for Default', exact: true }).click()
  await expect(codex.getByRole('status')).toHaveText('Connection cancelled.')
  await expect(page.locator(`[data-terminal-session="${secondSessionId}"]`)).toHaveCount(0)
  await openFreshProjectTerminal(page, [firstSessionId, secondSessionId])
})

test('busy work explains why account changes are disabled', async ({ page }) => {
  await openAccounts(page, 'accountBusy')
  await expect(card(page).getByText('Active work in Default must finish before changing accounts.')).toBeVisible()
  await expect(card(page).getByRole('button', { name: 'Connect Codex for Default', exact: true })).toBeDisabled()
  await expect(card(page).getByRole('button', { name: 'Disconnect Codex for Default', exact: true })).toBeDisabled()
  await expect(card(page).getByRole('button', { name: 'Refresh Codex for Default', exact: true })).toBeEnabled()
})
