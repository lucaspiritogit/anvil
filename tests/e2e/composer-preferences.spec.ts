import { browseProvider, chooseProvider } from './composer-setup'
import { expect, test } from '@playwright/test'

const fixture = '/tests/e2e/fixture/'

test('fresh composer chooses provider and model together and leaves selection unset on cancel', async ({ page }, testInfo) => {
  await page.goto(fixture)
  const composer = page.getByRole('form', { name: 'Start a task' })
  const model = composer.getByRole('button', { name: 'Choose a model', exact: true })
  await expect(model).toBeEnabled()
  await expect(composer.getByRole('button', { name: 'Agent', exact: true })).toHaveCount(0)
  await composer.getByRole('textbox').fill('Use my selected model')
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('composer-empty.png') })
  const dialog = await browseProvider(model, 'opencode')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(model).toHaveText('Choose a model')
  await expect(composer.getByRole('combobox', { name: 'Reasoning effort' })).toHaveValue('')
  await composer.getByRole('textbox').press('Enter')
  expect(await page.evaluate(() => window.composerTest.starts)).toEqual([])
  await chooseProvider(model, 'codex', 'gpt-5-mini')
  await expect(composer.getByRole('button', { name: 'Model: GPT 5 Mini', exact: true })).toHaveAccessibleDescription('Codex')
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
  await page.screenshot({ path: testInfo.outputPath('composer-selected.png') })
})

test('the last configuration survives provider switches, task submission, project switches, and reloads', async ({ page }) => {
  await page.goto(fixture)
  const composer = page.getByRole('form', { name: 'Start a task' })
  const provider = composer.getByRole('button', { name: /^(Choose a model|Model:)/ })
  await chooseProvider(provider, 'codex', 'gpt-5-mini')
  await composer.getByRole('combobox', { name: 'Reasoning effort' }).selectOption('native-max')
  await chooseProvider(provider, 'opencode', 'provider/model')
  await chooseProvider(provider, 'codex')
  await expect(composer.getByRole('button', { name: 'Model: GPT 5 Mini', exact: true })).toBeVisible()
  await composer.getByRole('textbox').fill('Keep my configuration')
  await composer.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('main').getByRole('heading', { name: 'Keep my configuration', exact: true })).toBeVisible()
  await page.keyboard.press('Control+n')
  await expect(provider).toHaveAccessibleDescription('Codex')
  await expect(composer.getByRole('button', { name: 'Model: GPT 5 Mini', exact: true })).toBeVisible()
  await page.getByRole('combobox', { name: 'Project', exact: true }).click()
  await page.getByRole('option').filter({ hasText: '/tmp/workbench' }).click()
  await expect(provider).toHaveAccessibleDescription('Codex')
  await expect(composer.getByRole('combobox', { name: 'Reasoning effort' })).toHaveValue('native-max')
  await page.reload()
  await expect(provider).toHaveAccessibleDescription('Codex')
  await expect(composer.getByRole('button', { name: 'Model: GPT 5 Mini', exact: true })).toBeVisible()
  await expect(composer.getByRole('combobox', { name: 'Reasoning effort' })).toHaveValue('native-max')
  await chooseProvider(provider, 'opencode')
  await expect(composer.getByRole('button', { name: 'Model: model', exact: true })).toBeVisible()
})

for (const saved of [
  'not valid JSON',
  JSON.stringify({ state: { agentId: 42, modelsByAgent: null, reasoningByAgentModel: [] }, version: 0 }),
  JSON.stringify({ state: { agentId: 'removed-provider', modelsByAgent: { codex: 42 }, reasoningByAgentModel: null }, version: 0 })
]) {
  test(`invalid or unavailable saved configuration does not select a default provider: ${saved}`, async ({ page }) => {
    await page.addInitScript((saved) => localStorage.setItem('anvil-composer-preferences-v2', saved), saved)
    await page.goto(fixture)
    const composer = page.getByRole('form', { name: 'Start a task' })
    const provider = composer.getByRole('button', { name: /^(Choose a model|Model:)/ })
    await expect(provider).toHaveText('Choose a model')
    await expect(composer.getByRole('combobox', { name: 'Reasoning effort' })).toHaveValue('')
    await expect(composer.getByRole('button', { name: 'Choose a model', exact: true })).toBeEnabled()
    await browseProvider(provider, 'codex')
    await page.keyboard.press('Escape')
    await expect(provider).toHaveText('Choose a model')
  })
}

test('old composer preferences are isolated without migration', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('anvil-composer-preferences', JSON.stringify({ state: {
    agentId: 'codex', modelsByAgent: { codex: 'gpt-5' }, thinkingLevel: 'High', modelEffort: 'max'
  }, version: 0 })))
  await page.goto(fixture)
  await expect(page.getByRole('button', { name: /^(Choose a model|Model:)/ })).toHaveText('Choose a model')
  await expect(page.getByRole('combobox', { name: 'Reasoning effort' })).toHaveValue('')
})

test('workspace switching restores independent models and reasoning and clears personal drafts', async ({ page }) => {
  await page.goto(`${fixture}?workspaces`)
  const composer = page.getByRole('form', { name: 'Start a task' })
  const provider = composer.getByRole('button', { name: /^(Choose a model|Model:)/ })
  await chooseProvider(provider, 'codex', 'gpt-5-mini')
  await composer.getByRole('combobox', { name: 'Reasoning effort' }).selectOption('native-max')
  await composer.getByRole('textbox').fill('Personal draft must stay private')
  await page.getByRole('button', { name: 'Create test workspace' }).click()
  await expect(provider).toHaveText('Choose a model')
  await expect(composer.getByRole('textbox')).toHaveValue('')
  await chooseProvider(provider, 'opencode', 'provider/model')
  await page.getByRole('combobox', { name: 'Test workspace', exact: true }).selectOption({ label: 'Default' })
  await expect(provider).toHaveText('GPT 5 Mini')
  await expect(composer.getByRole('combobox', { name: 'Reasoning effort' })).toHaveValue('native-max')
  await expect(composer.getByRole('textbox')).toHaveValue('')
  await page.getByRole('combobox', { name: 'Test workspace', exact: true }).selectOption({ label: 'Work' })
  await page.reload()
  await expect(page.getByRole('combobox', { name: 'Test workspace', exact: true })).toHaveText('DefaultWork')
  await expect(provider).toHaveText('model')
  await expect(provider).toHaveAccessibleDescription('OpenCode')
})
