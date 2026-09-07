import { expect, test } from '@playwright/test'
import { restoreComposerSelection } from './composer-setup'

test.beforeEach(async ({ page }) => restoreComposerSelection(page))

const fixture = '/tests/e2e/fixture/'

test('overview keeps usage read-only and the composer visible in a short window', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 600 })
  await page.goto(fixture)
  const main = page.getByRole('main')
  await expect(main.getByRole('heading', { name: 'Usage this month' })).toBeVisible()
  await expect(main.getByRole('heading', { name: /^(Running|Ready for review|Completed)$/ })).toHaveCount(0)
  await expect(main.getByRole('button', { name: 'Edit limits' })).toHaveCount(0)
  await expect(main.getByRole('button', { name: 'Start new task' })).toHaveCount(0)
  await expect(main.getByRole('button', { name: 'Send', exact: true })).toBeInViewport()
  await expect(main.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await main.getByRole('textbox', { name: 'Task prompt' }).fill('   ')
  await expect(main.getByRole('button', { name: 'Send', exact: true })).toBeDisabled()
  await page.screenshot({ path: testInfo.outputPath('overview-short.png') })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.screenshot({ path: testInfo.outputPath('overview-desktop.png') })
})

for (const [scenario, tokens, cost] of [['', '0', '$0.0000'], ['?usage=1', '128K', '$12.34']]) {
  test(`monthly usage shows prominent totals without limit meters ${scenario || 'at zero'}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 900, height: 600 })
    await page.goto(`${fixture}${scenario}`)
    const usage = page.getByRole('region', { name: 'Usage this month' })
    await expect(usage.getByRole('term')).toHaveText(['Tokens used', 'Cost in USD'])
    const values = usage.getByRole('definition')
    await expect(values).toHaveText([tokens, cost])
    for (const value of await values.all()) {
      await expect(value).toHaveCSS('font-size', '32px')
      await expect(value).toHaveCSS('font-weight', '600')
      await expect(value).toBeInViewport()
    }
    await expect(usage.getByText(/limit| of /i)).toHaveCount(0)
    await expect(usage.locator('[style*="width"]')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeInViewport()
    await page.screenshot({ path: testInfo.outputPath('monthly-usage.png') })
  })
}

test('Send dispatches the prompt and selected model to the current project', async ({ page }) => {
  await page.goto(fixture)
  const composer = page.getByRole('form', { name: 'Start a task' })
  await composer.getByRole('textbox').fill('  Build a project search  ')
  await composer.getByRole('button', { name: 'Model: GPT 5', exact: true }).click()
  await page.getByRole('dialog', { name: 'Choose model' }).getByRole('button', { name: 'GPT 5 Mini', exact: true }).click()
  await composer.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('main').getByRole('heading', { name: 'Build a project search' })).toBeVisible()
  const startedTasks = await page.evaluate(async () => (await window.anvil.tasks.list()).filter((task) => task.id.startsWith('started-')))
  expect(startedTasks).toHaveLength(1)
  expect(startedTasks[0]).toMatchObject({ projectId: 'project-0', prompt: 'Build a project search', agentId: 'codex', model: 'gpt-5-mini' })
})

for (const modifier of ['Meta', 'Control']) {
  test(`${modifier}+Enter dispatches once, while Enter adds a newline`, async ({ page }) => {
    await page.goto(fixture)
    await page.getByRole('navigation', { name: 'Filter tasks by project' }).getByRole('button', { name: 'Workbench', exact: true }).click()
    const composer = page.getByRole('form', { name: 'Start a task' })
    const prompt = composer.getByRole('textbox')
    await composer.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('opencode')
    await prompt.fill('Build search')
    await prompt.press('Enter')
    await expect(prompt).toHaveValue('Build search\n')
    await expect(composer).toBeVisible()
    await prompt.press(`${modifier}+Enter`)
    await page.keyboard.press(`${modifier}+Enter`)
    await expect(page.getByRole('main').getByRole('heading', { name: 'Build search', exact: true })).toBeVisible()
    const startedTasks = await page.evaluate(async () => (await window.anvil.tasks.list()).filter((task) => task.id.startsWith('started-')))
    expect(startedTasks).toHaveLength(1)
    expect(startedTasks[0]).toMatchObject({ projectId: 'project-1', agentId: 'opencode', model: 'provider/model' })
  })
}

test('a dispatch failure keeps the draft and lets the user retry', async ({ page }) => {
  await page.goto(`${fixture}?startFailure=1`)
  const composer = page.getByRole('form', { name: 'Start a task' })
  await composer.getByRole('textbox').fill('Keep this draft')
  await composer.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(composer.getByRole('alert')).toHaveText('Task could not be started')
  await expect(composer.getByRole('textbox')).toHaveValue('Keep this draft')
  await expect(composer.getByRole('button', { name: 'Send', exact: true })).toBeEnabled()
})

for (const [platform, modifier] of [['darwin', 'Meta'], ['linux', 'Control'], ['win32', 'Control']]) {
  test(`${platform} new-task shortcut focuses the composer without submitting or clearing its draft`, async ({ page }) => {
    await page.goto(`${fixture}?platform=${platform}`)
    const prompt = page.getByRole('textbox', { name: 'Task prompt' })
    await prompt.fill('Keep this draft')
    await page.getByRole('searchbox', { name: 'Search tasks' }).click()
    await page.keyboard.press(`${modifier}+n`)
    await expect(prompt).toBeFocused()
    await expect(prompt).toHaveValue('Keep this draft')
    await expect(page.getByRole('heading', { name: 'New task', exact: true })).toHaveCount(0)

    await page.getByRole('button', { name: 'Open task: Layout test task', exact: true }).click()
    await expect(page.getByRole('log', { name: 'Task output' })).toBeVisible()
    await page.keyboard.press(`${modifier}+n`)
    const workbenchPrompt = page.getByRole('textbox', { name: 'Task prompt' })
    await expect(workbenchPrompt).toBeFocused()
    await expect(workbenchPrompt).toBeInViewport()
    await expect(page.getByRole('log', { name: 'Task output' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Terminal', exact: true }).click()
    await page.locator('.xterm-helper-textarea').focus()
    await page.evaluate(() => {
      window.anvil.terminal.write = () => { throw new Error('App shortcut was forwarded to the terminal') }
    })
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.keyboard.press(`${modifier}+n`)
    await expect(workbenchPrompt).toBeFocused()
    expect(pageErrors).toEqual([])

    const startedTasks = await page.evaluate(async () => (await window.anvil.tasks.list()).filter((task) => task.id.startsWith('started-')))
    expect(startedTasks).toHaveLength(0)
  })
}

test('the composer shortcut does not steal focus from a deletion confirmation', async ({ page }) => {
  await page.goto(fixture)
  await page.getByRole('button', { name: 'Open task: Polish task cards', exact: true }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Delete', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete task?' })
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await page.keyboard.press('Control+n')
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
})

test('switching projects clears the previous project draft', async ({ page }) => {
  await page.goto(fixture)
  await page.getByRole('textbox', { name: 'Task prompt' }).fill('Only for Anvil')
  await page.getByRole('navigation', { name: 'Filter tasks by project' }).getByRole('button', { name: 'Workbench', exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Task prompt' })).toHaveValue('')
})
