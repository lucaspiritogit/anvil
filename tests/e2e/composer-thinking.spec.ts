import { expect, test, type Page } from '@playwright/test'

const fixture = '/tests/e2e/fixture/?thinkingModels'

async function configureModels(page: Page): Promise<void> {
  await page.goto(fixture)
  await page.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('opencode')
}

test('model selection refreshes available efforts and remembers a valid choice per model', async ({ page }, testInfo) => {
  await configureModels(page)
  const composer = page.getByRole('form', { name: 'Start a task' })
  const thinking = composer.getByRole('combobox', { name: 'Thinking level' })
  const chooseModel = async (name: string): Promise<void> => {
    await composer.getByRole('button', { name: /^(Choose a Model|Model:)/ }).click()
    await page.getByRole('dialog', { name: 'Choose model' }).getByRole('button', { name, exact: true }).click()
  }
  await chooseModel('reasoner')
  await expect(thinking).toHaveValue('medium')
  await thinking.selectOption('low')
  await chooseModel('deepseek-v4')
  await expect(thinking.locator('option')).toHaveText(['High', 'Max'])
  await expect(thinking).toHaveValue('high')
  await thinking.selectOption('max')
  await page.screenshot({ path: testInfo.outputPath('deepseek-thinking.png') })
  await chooseModel('reasoner')
  await expect(thinking).toHaveValue('low')
  await chooseModel('deepseek-v4')
  await expect(thinking).toHaveValue('max')
  await page.reload()
  await expect(thinking).toHaveValue('max')
  await composer.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('codex')
  await expect(thinking).toHaveValue('Medium')
  await composer.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('opencode')
  await expect(thinking).toHaveValue('max')
  await composer.getByRole('textbox').fill('Use the selected effort')
  await composer.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('main').getByRole('heading', { name: 'Use the selected effort', exact: true })).toBeVisible()
  const started = await page.evaluate(async () => (await window.anvil.tasks.list()).find((task) => task.id.startsWith('started-')))
  expect(started).toMatchObject({ model: 'openrouter/deepseek/deepseek-v4', modelEffort: 'max' })
  expect(started).not.toHaveProperty('thinkingLevel')
})

test('stale saved effort is replaced and persisted when metadata loads', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('anvil-composer-preferences', JSON.stringify({ state: {
      agentId: 'opencode', modelsByAgent: { opencode: 'openrouter/deepseek/deepseek-v4' },
      thinkingLevel: 'Medium', effortsByModel: { 'openrouter/deepseek/deepseek-v4': 'medium' }
    }, version: 0 }))
  })
  await page.goto(fixture)
  await expect(page.getByRole('combobox', { name: 'Thinking level' })).toHaveValue('high')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('anvil-composer-preferences')!).state.effortsByModel))
    .toEqual({ 'openrouter/deepseek/deepseek-v4': 'high' })
})

test('late metadata refreshes only the selected agent and blocks stale effort submission while loading', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('anvil-composer-preferences', JSON.stringify({ state: {
      agentId: '', modelsByAgent: { opencode: 'openrouter/deepseek/deepseek-v4' }, thinkingLevel: 'Medium'
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
  const thinking = composer.getByRole('combobox', { name: 'Thinking level' })
  await agent.selectOption('opencode')
  await composer.getByRole('textbox').fill('Wait for model efforts')
  await expect(thinking).toBeDisabled()
  await expect(thinking.locator('option:checked')).toHaveText('Loading efforts…')
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await composer.getByRole('textbox').press('Control+Enter')
  expect(await page.evaluate(async () => (await window.anvil.tasks.list()).filter((task) => task.id.startsWith('started-')))).toHaveLength(0)
  await agent.selectOption('codex')
  await expect(thinking).toHaveValue('Medium')
  await page.evaluate(() => window.dispatchEvent(new Event('fixture:models-ready')))
  await expect(thinking).toHaveValue('Medium')
  await agent.selectOption('opencode')
  await expect(thinking).toHaveValue('high')
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
})

test('models without efforts disable the selector and omit effort from submission', async ({ page }) => {
  await configureModels(page)
  const composer = page.getByRole('form', { name: 'Start a task' })
  await composer.getByRole('button', { name: 'Choose a Model', exact: true }).click()
  await page.getByRole('dialog', { name: 'Choose model' }).getByRole('button', { name: 'plain', exact: true }).click()
  const thinking = composer.getByRole('combobox', { name: 'Thinking level' })
  await expect(thinking).toBeDisabled()
  await expect(thinking.locator('option:checked')).toHaveText('Agent default')
  await composer.getByRole('textbox').fill('Use the model default')
  await composer.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('main').getByRole('heading', { name: 'Use the model default', exact: true })).toBeVisible()
  const started = await page.evaluate(async () => (await window.anvil.tasks.list()).find((task) => task.id.startsWith('started-')))
  expect(started).not.toHaveProperty('modelEffort')
  expect(started).not.toHaveProperty('thinkingLevel')
})
