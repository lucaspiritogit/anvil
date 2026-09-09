import { expect, test, type Page } from '@playwright/test'

async function openAccounts(page: Page, query = 'workspaces'): Promise<void> {
  await page.goto(`/tests/e2e/fixture/?${query}`)
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Providers', exact: true }).click()
}

const card = (page: Page, provider = 'Codex', workspace = 'Default') => page.getByRole('region', { name: `${provider} account for ${workspace}`, exact: true })

async function complete(page: Page, workspaceId = 'default', success = true): Promise<void> {
  await page.evaluate(({ workspaceId, success }) => window.dispatchEvent(new CustomEvent('fixture:account-complete', {
    detail: { workspaceId, agentId: 'codex', success }
  })), { workspaceId, success })
}

test('workspace API key connect, redacted failure, retry and disconnect apply immediately', async ({ page }, testInfo) => {
  await openAccounts(page)
  const codex = card(page)
  await expect(codex.getByText('Signed out', { exact: true })).toBeVisible()
  await codex.getByLabel('Codex sign-in method for Default').selectOption('apiKey')
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
  test(`OpenCode native ${method} prompts accept interactive input and refresh on completion`, async ({ page }) => {
    await openAccounts(page)
    const opencode = card(page, 'OpenCode')
    await opencode.getByRole('button', { name: 'Connect OpenCode for Default', exact: true }).click()
    const terminal = opencode.getByLabel('Native provider login terminal')
    await expect(terminal).toBeVisible()
    await terminal.locator('textarea').focus()
    await page.keyboard.type(method)
    await page.keyboard.press('Enter')
    await expect(opencode.getByRole('status')).toHaveText(method === 'api' ? 'OpenAI: API key' : 'OpenAI: subscription')
    await expect(terminal).toBeHidden()
    await opencode.getByRole('button', { name: 'Connect OpenCode for Default', exact: true }).click()
    await opencode.getByRole('button', { name: 'Cancel OpenCode for Default', exact: true }).click()
    await expect(opencode.getByRole('status')).toHaveText('Connection cancelled.')
  })
}

test('busy work explains why account changes are disabled', async ({ page }) => {
  await openAccounts(page, 'accountBusy')
  await expect(card(page).getByText('Active work in Default must finish before changing accounts.')).toBeVisible()
  await expect(card(page).getByRole('button', { name: 'Connect Codex for Default', exact: true })).toBeDisabled()
  await expect(card(page).getByRole('button', { name: 'Disconnect Codex for Default', exact: true })).toBeDisabled()
  await expect(card(page).getByRole('button', { name: 'Refresh Codex for Default', exact: true })).toBeEnabled()
})
