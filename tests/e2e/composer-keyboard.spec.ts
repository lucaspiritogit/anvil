import { expect, test, type Page } from '@playwright/test'
import { browseProvider, chooseProvider, restoreComposerSelection } from './composer-setup'

const composer = (page: Page) => page.getByRole('form', { name: 'Start a task' })
const prompt = (page: Page) => composer(page).getByRole('textbox', { name: 'Task prompt' })
const send = (page: Page) => composer(page).getByRole('button', { name: 'Send', exact: true })

test.describe(() => {
  test.beforeEach(async ({ page }) => {
    await restoreComposerSelection(page)
    await page.goto('/tests/e2e/fixture/')
    await expect(prompt(page)).toBeVisible()
  })

  test('Shift+Enter edits at the caret and Enter sends the multiline draft intact', async ({ page }, testInfo) => {
    await prompt(page).fill('FirstLast')
    await prompt(page).evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(5, 5))
    await prompt(page).press('Shift+Enter')
    await prompt(page).pressSequentially('Middle')
    await prompt(page).press('Shift+Enter')
    await expect(prompt(page)).toHaveValue('First\nMiddle\nLast')
    expect(await page.evaluate(() => window.composerTest.starts)).toEqual([])
    await page.screenshot({ path: testInfo.outputPath('keyboard-overview.png') })
    await prompt(page).press('Enter')
    await expect.poll(() => page.evaluate(() => window.composerTest.starts.map((input) => input.prompt))).toEqual(['First\nMiddle\nLast'])
    await expect(composer(page)).toHaveCount(0)
  })

  test('empty and whitespace drafts do not send or gain an Enter newline', async ({ page }) => {
    for (const draft of ['', '  \n  ']) {
      await prompt(page).fill(draft)
      await expect(send(page)).toBeDisabled()
      await prompt(page).press('Enter')
      await expect(prompt(page)).toHaveValue(draft)
    }
    expect(await page.evaluate(() => window.composerTest.starts)).toEqual([])
  })

  test('IME confirmation and held Enter do not submit', async ({ page }) => {
    await prompt(page).fill('日本語の下書き')
    await expect(send(page)).toBeEnabled()
    await prompt(page).dispatchEvent('keydown', { key: 'Enter', isComposing: true })
    await prompt(page).dispatchEvent('keydown', { key: 'Enter', keyCode: 229 })
    await prompt(page).dispatchEvent('compositionstart', { data: '語' })
    // Some IMEs omit isComposing on the confirmation keydown.
    await prompt(page).dispatchEvent('keydown', { key: 'Enter' })
    await prompt(page).dispatchEvent('compositionend', { data: '語' })
    await prompt(page).dispatchEvent('keydown', { key: 'Enter', repeat: true })
    await expect(prompt(page)).toHaveValue('日本語の下書き')
    expect(await page.evaluate(() => window.composerTest.starts)).toEqual([])
    await prompt(page).press('Enter')
    await expect.poll(() => page.evaluate(() => window.composerTest.starts.length)).toBe(1)
  })

  test('busy submission ignores additional Enter events and form submissions', async ({ page }) => {
    await page.evaluate(() => {
      const start = window.anvil.tasks.start
      window.anvil.tasks.start = async (input) => {
        await new Promise<void>((resolve) => window.addEventListener('fixture:start-ready', () => resolve(), { once: true }))
        return start(input)
      }
    })
    await prompt(page).fill('Start once')
    await prompt(page).press('Enter')
    await expect(prompt(page)).toBeDisabled()
    for (const repeat of [true, true, false]) await prompt(page).dispatchEvent('keydown', { key: 'Enter', repeat })
    await composer(page).dispatchEvent('submit')
    await page.evaluate(() => window.dispatchEvent(new Event('fixture:start-ready')))
    await expect(composer(page)).toHaveCount(0)
    expect(await page.evaluate(() => window.composerTest.starts.map((input) => input.prompt))).toEqual(['Start once'])
  })

  for (const shortcut of ['Control+Enter', 'Meta+Enter']) {
    test(`${shortcut} remains a send shortcut`, async ({ page }) => {
      await prompt(page).fill('Compatibility shortcut')
      await expect(send(page)).toBeEnabled()
      await prompt(page).press(shortcut)
      await expect.poll(() => page.evaluate(() => window.composerTest.starts.length)).toBe(1)
    })
  }

  test('the file picker consumes Enter while loading, empty, and selecting a result', async ({ page }) => {
    await page.evaluate(() => {
      const files = window.anvil.projects.files
      window.anvil.projects.files = async (input) => {
        window.anvil.projects.files = files
        await new Promise<void>((resolve) => window.addEventListener('fixture:files-ready', () => resolve(), { once: true }))
        return files(input)
      }
    })
    await prompt(page).fill('@index')
    const list = page.getByRole('listbox', { name: 'Project files' })
    await expect(composer(page).getByRole('status')).toHaveText('Loading project files…')
    await expect(list.getByRole('option')).toHaveCount(0)
    await prompt(page).press('Enter')
    await expect(prompt(page)).toHaveValue('@index')
    expect(await page.evaluate(() => window.composerTest.starts)).toEqual([])
    await page.evaluate(() => window.dispatchEvent(new Event('fixture:files-ready')))
    await expect(list.getByRole('option')).toHaveCount(2)
    await prompt(page).fill('@no-matching-file')
    await expect(list.getByRole('option')).toHaveCount(0)
    await prompt(page).press('Enter')
    await expect(prompt(page)).toHaveValue('@no-matching-file')
    await prompt(page).fill('@index')
    await expect(list.getByRole('option')).toHaveCount(2)
    await prompt(page).press('ArrowDown')
    const choice = list.getByRole('option').nth(1)
    await expect(choice).toHaveAttribute('aria-selected', 'true')
    const path = await choice.innerText()
    await page.keyboard.down('Enter')
    await expect(prompt(page)).toHaveValue(`@${JSON.stringify(path)} `)
    await expect(list).toHaveCount(0)
    await page.keyboard.down('Enter')
    expect(await page.evaluate(() => window.composerTest.starts)).toEqual([])
    await page.keyboard.up('Enter')
    await prompt(page).press('Enter')
    await expect.poll(() => page.evaluate(() => window.composerTest.starts[0]?.fileReferences)).toEqual([path])
  })

  test('provider and model selection and branch dialogs handle Enter without sending the draft', async ({ page }) => {
    await prompt(page).fill('Keep this draft through picker selection')
    const trigger = composer(page).getByRole('button', { name: /^(Choose a model|Model:)/ })
    await trigger.click()
    const model = page.getByRole('dialog', { name: 'Choose model', exact: true })
    const provider = model.getByRole('button', { name: 'OpenCode', exact: true })
    await provider.focus()
    await provider.press('Enter')
    await expect(model).toBeVisible()
    const search = model.getByRole('searchbox')
    await search.fill('model')
    await search.press('Enter')
    await expect(model).toBeVisible()
    await search.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(model).toHaveCount(0)
    await expect(trigger).toHaveAccessibleDescription('OpenCode')

    const branch = page.getByRole('button', { name: 'Project branch', exact: true })
    await branch.click()
    const branches = page.getByRole('dialog', { name: 'Choose branch', exact: true })
    const branchSearch = branches.getByRole('searchbox')
    await branchSearch.fill('feature/composer')
    await branchSearch.press('Enter')
    await expect(branches).toBeVisible()
    await branchSearch.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(branches).toHaveCount(0)
    await expect(branch).toHaveAccessibleDescription('feature/composer')
    await expect(prompt(page)).toHaveValue('Keep this draft through picker selection')
    expect(await page.evaluate(() => window.composerTest.starts)).toEqual([])
    await expect(send(page)).toBeEnabled()
    await prompt(page).press('Enter')
    await expect.poll(() => page.evaluate(() => window.composerTest.starts[0]?.agentId)).toBe('opencode')
  })

  test('Enter stays guarded until a valid provider and model are selected', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem('anvil-composer-preferences-v2', JSON.stringify({
      state: { agentId: 'removed-provider', modelsByAgent: { codex: '   ' }, reasoningByAgentModel: {} }, version: 0
    })))
    await page.reload()
    await prompt(page).fill('Choose my provider first')
    await prompt(page).press('Enter')
    await expect(send(page)).toBeDisabled()
    await browseProvider(composer(page).getByRole('button', { name: /^(Choose a model|Model:)/ }), 'codex')
    await page.keyboard.press('Escape')
    const options = page.getByRole('group', { name: 'Task options', exact: true })
    if (await options.isVisible()) await page.keyboard.press('Escape')
    await prompt(page).press('Enter')
    await expect(send(page)).toBeDisabled()
    await expect(prompt(page)).toHaveValue('Choose my provider first')
    expect(await page.evaluate(() => window.composerTest.starts)).toEqual([])
  })

  test('Enter waits for the selected provider model catalogue', async ({ page }) => {
    await page.evaluate(() => {
      const models = window.anvil.agents.models
      window.anvil.agents.models = async (agentId) => {
        await new Promise<void>((resolve) => window.addEventListener('fixture:models-ready', () => resolve(), { once: true }))
        return models(agentId)
      }
    })
    await prompt(page).fill('Wait for models')
    await chooseProvider(composer(page).getByRole('button', { name: /^(Choose a model|Model:)/ }), 'opencode')
    const options = page.getByRole('group', { name: 'Task options', exact: true })
    if (await options.isVisible()) await page.keyboard.press('Escape')
    await expect(send(page)).toBeDisabled()
    await prompt(page).press('Enter')
    await expect(prompt(page)).toHaveValue('Wait for models')
    expect(await page.evaluate(() => window.composerTest.starts)).toEqual([])
    await page.evaluate(() => window.dispatchEvent(new Event('fixture:models-ready')))
    await expect(send(page)).toBeEnabled()
    await prompt(page).press('Enter')
    await expect.poll(() => page.evaluate(() => window.composerTest.starts.length)).toBe(1)
  })
})
