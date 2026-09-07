import { expect, test, type Page } from '@playwright/test'

const fixture = '/tests/e2e/fixture/?reasoningModels'

async function configureModels(page: Page): Promise<void> {
  await page.goto(fixture)
  await page.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('opencode')
}

test('model selection refreshes available efforts and remembers a valid choice per model', async ({ page }, testInfo) => {
  await configureModels(page)
  const composer = page.getByRole('form', { name: 'Start a task' })
  const reasoning = composer.getByRole('combobox', { name: 'Reasoning effort' })
  const chooseModel = async (name: string): Promise<void> => {
    await composer.getByRole('button', { name: /^(Choose a Model|Model:)/ }).click()
    await page.getByRole('dialog', { name: 'Choose model' }).getByRole('button', { name, exact: true }).click()
  }
  await chooseModel('reasoner')
  await expect(reasoning).toHaveValue('medium')
  await reasoning.selectOption('low')
  await chooseModel('deepseek-v4')
  await expect(reasoning.locator('option')).toHaveText(['high', 'max'])
  await expect(reasoning).toHaveValue('high')
  await reasoning.selectOption('max')
  await page.screenshot({ path: testInfo.outputPath('deepseek-reasoning.png') })
  await chooseModel('reasoner')
  await expect(reasoning).toHaveValue('low')
  await chooseModel('deepseek-v4')
  await expect(reasoning).toHaveValue('max')
  await page.reload()
  await expect(reasoning).toHaveValue('max')
  await composer.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('codex')
  await expect(reasoning).toHaveValue('')
  await composer.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('opencode')
  await expect(reasoning).toHaveValue('max')
  await composer.getByRole('textbox').fill('Use the selected effort')
  await composer.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('main').getByRole('heading', { name: 'Use the selected effort', exact: true })).toBeVisible()
  const started = await page.evaluate(async () => (await window.anvil.tasks.list()).find((task) => task.id.startsWith('started-')))
  expect(started).toMatchObject({ model: 'openrouter/deepseek/deepseek-v4', reasoningEffort: 'max' })
})

test('stale saved effort is replaced and persisted when metadata loads', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('anvil-composer-preferences-v2', JSON.stringify({ state: {
      agentId: 'opencode', modelsByAgent: { opencode: 'openrouter/deepseek/deepseek-v4' },
      reasoningByAgentModel: { '["opencode","openrouter/deepseek/deepseek-v4"]': 'medium' }
    }, version: 0 }))
  })
  await page.goto(fixture)
  await expect(page.getByRole('combobox', { name: 'Reasoning effort' })).toHaveValue('high')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('anvil-composer-preferences-v2')!).state.reasoningByAgentModel))
    .toEqual({ '["opencode","openrouter/deepseek/deepseek-v4"]': 'high' })
})

test('late metadata refreshes only the selected agent and blocks stale effort submission while loading', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('anvil-composer-preferences-v2', JSON.stringify({ state: {
      agentId: '', modelsByAgent: { opencode: 'openrouter/deepseek/deepseek-v4' }
    }, version: 0 }))
  })
  await page.goto(fixture)
  await page.evaluate(() => {
    const original = window.anvil.agents.models
    window.anvil.agents.models = async (agentId) => {
      if (agentId === 'opencode') await new Promise<void>((resolve) => window.addEventListener('fixture:models-ready', () => resolve(), { once: true }))
      return original(agentId)
    }
  })
  const composer = page.getByRole('form', { name: 'Start a task' })
  const agent = composer.getByRole('combobox', { name: 'Agent', exact: true })
  const reasoning = composer.getByRole('combobox', { name: 'Reasoning effort' })
  await agent.selectOption('opencode')
  await composer.getByRole('textbox').fill('Wait for model efforts')
  await expect(reasoning).toBeDisabled()
  await expect(reasoning.locator('option:checked')).toHaveText('Loading efforts…')
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await composer.getByRole('textbox').press('Control+Enter')
  expect(await page.evaluate(async () => (await window.anvil.tasks.list()).filter((task) => task.id.startsWith('started-')))).toHaveLength(0)
  await agent.selectOption('codex')
  await expect(reasoning).toHaveValue('')
  await page.evaluate(() => window.dispatchEvent(new Event('fixture:models-ready')))
  await expect(reasoning).toHaveValue('')
  await agent.selectOption('opencode')
  await expect(reasoning).toHaveValue('high')
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
})

test('models without efforts disable the selector and omit effort from submission', async ({ page }) => {
  await configureModels(page)
  const composer = page.getByRole('form', { name: 'Start a task' })
  await composer.getByRole('button', { name: 'Choose a Model', exact: true }).click()
  await page.getByRole('dialog', { name: 'Choose model' }).getByRole('button', { name: 'plain', exact: true }).click()
  const reasoning = composer.getByRole('combobox', { name: 'Reasoning effort' })
  await expect(reasoning).toBeDisabled()
  await expect(reasoning.locator('option:checked')).toHaveText('Agent default')
  await composer.getByRole('textbox').fill('Use the model default')
  await composer.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('main').getByRole('heading', { name: 'Use the model default', exact: true })).toBeVisible()
  const started = await page.evaluate(async () => (await window.anvil.tasks.list()).find((task) => task.id.startsWith('started-')))
  expect(started).not.toHaveProperty('reasoningEffort')
})

test('the same model ID keeps separate agent choices and forwards the Codex option ID', async ({ page }) => {
  await page.goto(fixture)
  await page.evaluate(() => {
    window.anvil.agents.models = async (agentId) => ({
      agentId, models: ['shared-model'], reasoningByModel: {
        'shared-model': {
          options: [{ id: 'native-max', label: 'Maximum reasoning' }, { id: 'fast', label: 'Fast reasoning' }],
          default: agentId === 'codex' ? 'native-max' : 'fast'
        }
      }
    })
  })
  const composer = page.getByRole('form', { name: 'Start a task' })
  const agent = composer.getByRole('combobox', { name: 'Agent', exact: true })
  const effort = composer.getByRole('combobox', { name: 'Reasoning effort' })
  const selectModel = async (): Promise<void> => {
    await composer.getByRole('button', { name: 'Choose a Model', exact: true }).click()
    await page.getByRole('dialog', { name: 'Choose model' }).getByRole('button', { name: 'shared-model', exact: true }).click()
  }
  await agent.selectOption('codex')
  await selectModel()
  await expect(effort).toHaveValue('native-max')
  await expect(effort.locator('option:checked')).toHaveText('Maximum reasoning')
  await agent.selectOption('opencode')
  await selectModel()
  await expect(effort).toHaveValue('fast')
  await agent.selectOption('codex')
  await expect(effort).toHaveValue('native-max')
  await composer.getByRole('textbox').fill('Use Codex native reasoning')
  await composer.getByRole('button', { name: 'Send', exact: true }).click()
  await expect.poll(() => page.evaluate(async () => (await window.anvil.tasks.list()).find((task) => task.id.startsWith('started-'))))
    .toMatchObject({ agentId: 'codex', model: 'shared-model', reasoningEffort: 'native-max' })
})

test('failed discovery disables reasoning and omits a saved choice', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('anvil-composer-preferences-v2', JSON.stringify({ state: {
    agentId: '', modelsByAgent: { codex: 'gpt-5' },
    reasoningByAgentModel: { '["codex","gpt-5"]': 'native-max' }
  }, version: 0 })))
  await page.goto(fixture)
  await page.evaluate(() => {
    window.anvil.agents.models = async () => { throw new Error('Discovery failed') }
  })
  const composer = page.getByRole('form', { name: 'Start a task' })
  await composer.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('codex')
  const effort = composer.getByRole('combobox', { name: 'Reasoning effort' })
  await expect(effort).toBeDisabled()
  await expect(effort.locator('option:checked')).toHaveText('Reasoning unavailable')
  await composer.getByRole('textbox').fill('Use backend default after discovery failure')
  await composer.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('main').getByRole('heading', { name: 'Use backend default after discovery failure', exact: true })).toBeVisible()
  const started = await page.evaluate(async () => (await window.anvil.tasks.list()).find((task) => task.id.startsWith('started-')))
  expect(started).not.toHaveProperty('reasoningEffort')
})
