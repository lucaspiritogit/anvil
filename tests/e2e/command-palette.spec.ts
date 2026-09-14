import { expect, test, type Page } from '@playwright/test'

const fixture = '/tests/e2e/fixture/'

async function seedComposer(page: Page, agentId = 'codex', model = 'gpt-5'): Promise<void> {
  await page.addInitScript(({ agentId, model }) => {
    localStorage.setItem('fixture:preferences', JSON.stringify({
      default: {
        composer: {
          agentId,
          modelsByAgent: { [agentId]: model },
          reasoningByAgentModel: {}
        },
        lastProjectId: null
      }
    }))
  }, { agentId, model })
}

async function openPalette(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
  await page.keyboard.press('F1')
  const palette = page.getByRole('dialog', { name: 'Command palette', exact: true })
  await expect(palette).toBeVisible()
  return palette
}

test('F1 opens once, restores focus, and yields to settings, terminals, dialogs, and workspace switches', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('fixture:workspaces', JSON.stringify([
      { id: 'default', name: 'Default', createdAt: 0 },
      { id: 'work', name: 'Work', createdAt: 1 }
    ]))
  })
  await page.goto(`${fixture}?workspaces`)
  const prompt = page.getByRole('textbox', { name: 'Task prompt' })
  await expect(prompt).toBeVisible()

  const repeatedWasPrevented = await prompt.evaluate((element) => {
    const event = new KeyboardEvent('keydown', { key: 'F1', repeat: true, bubbles: true, cancelable: true })
    element.dispatchEvent(event)
    return event.defaultPrevented
  })
  expect(repeatedWasPrevented).toBe(true)
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0)

  await prompt.press('F1')
  const palette = page.getByRole('dialog', { name: 'Command palette', exact: true })
  await expect(palette.getByRole('searchbox', { name: 'Search commands' })).toBeFocused()
  await page.keyboard.press('F1')
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(1)
  await page.keyboard.press('Control+,')
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(prompt).toBeFocused()

  await prompt.press('Control+,')
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await page.keyboard.press('F1')
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  const modelTrigger = page.getByRole('button', { name: /^(Choose a model|Model:)/ }).first()
  await modelTrigger.press('Enter')
  const modelDialog = page.getByRole('dialog', { name: 'Choose model', exact: true })
  await expect(modelDialog).toBeVisible()
  await page.keyboard.press('F1')
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  const originalSelectInstalled = await page.evaluate(() => {
    const select = window.anvil.workspaces.select
    window.anvil.workspaces.select = async (id) => {
      await new Promise<void>((resolve) => window.addEventListener('fixture:finish-workspace-switch', () => resolve(), { once: true }))
      return select(id)
    }
    return true
  })
  expect(originalSelectInstalled).toBe(true)
  const workspace = page.getByRole('combobox', { name: 'Workspace', exact: true })
  await workspace.press('Control+A')
  await workspace.pressSequentially('Work')
  await workspace.press('ArrowDown')
  await workspace.press('Enter')
  await expect(page.getByRole('status')).toHaveText('Switching workspace…')
  await page.keyboard.press('F1')
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0)
  await page.evaluate(() => window.dispatchEvent(new Event('fixture:finish-workspace-switch')))
  await expect(workspace).toHaveValue('Work')

  await prompt.press('Control+t')
  const terminal = page.getByRole('region', { name: 'Project terminal', exact: true })
  await expect(terminal.locator('canvas')).toBeVisible()
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest('[data-terminal]')))).toBe(true)
  await page.keyboard.press('F1')
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toHaveCount(0)
})

test('keyboard traversal changes provider, model, thinking, and project with persisted selections', async ({ page }) => {
  await seedComposer(page)
  await page.goto(fixture)
  const prompt = page.getByRole('textbox', { name: 'Task prompt' })
  await prompt.press('F1')
  const palette = page.getByRole('dialog', { name: 'Command palette', exact: true })
  await expect(palette.getByRole('searchbox', { name: 'Search commands' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(palette.getByRole('menuitem', { name: /New task/ })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')

  const modelDialog = page.getByRole('dialog', { name: 'Choose model', exact: true })
  const providers = modelDialog.getByRole('navigation', { name: 'Providers' })
  await expect(modelDialog.getByRole('searchbox', { name: 'Search models' })).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(providers.getByRole('button', { name: 'Codex', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(providers.getByRole('button', { name: 'OpenCode', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  await expect(modelDialog.getByRole('group', { name: 'Models', exact: true })
    .getByRole('button', { name: 'model', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(palette.getByRole('menuitem', { name: /Change model/ })).toBeFocused()
  await expect.poll(() => page.evaluate(async () => (await window.anvil.workspaces.getPreferences('default')).composer))
    .toMatchObject({ agentId: 'opencode', modelsByAgent: { codex: 'gpt-5', opencode: 'provider/model' } })

  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Enter')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(palette.getByRole('menuitem', { name: /Change model/ })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  const thinking = page.getByRole('dialog', { name: 'Choose thinking' })
  await expect(thinking.getByRole('button', { name: 'High', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await expect(thinking.getByRole('button', { name: 'Maximum reasoning', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(palette.getByRole('menuitem', { name: /Change thinking/ })).toBeFocused()
  await expect.poll(() => page.evaluate(async () => (await window.anvil.workspaces.getPreferences('default')).composer.reasoningByAgentModel))
    .toEqual({ '["codex","gpt-5"]': 'native-max' })

  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  const projects = page.getByRole('dialog', { name: 'Choose project' })
  await expect(projects.getByRole('button', { name: /^Anvil\b/ })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(palette.getByRole('menuitem', { name: /Change project/ })).toBeFocused()
  await expect(page.getByTestId('composer-project-name')).toHaveText('Workbench')
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)
})

test('terminal and caffeine commands use app lifecycles and pending caffeine cannot be repeated', async ({ page }) => {
  await page.goto(`${fixture}?settingsControlled`)
  const palette = await openPalette(page)
  await expect(palette.getByRole('searchbox', { name: 'Search commands' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('End')
  const caffeine = palette.getByRole('menuitem', { name: /Toggle caffeine mode/ })
  await expect(caffeine).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(caffeine).toHaveAttribute('aria-pressed', 'true')
  await expect(caffeine).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Enter')
  expect(await page.evaluate(() => window.settingsTest.calls)).toEqual([{ caffeineMode: true }])
  await page.evaluate(() => window.settingsTest.release())
  await expect.poll(() => page.evaluate(async () => (await window.anvil.settings.get()).caffeineMode)).toBe(true)

  await page.keyboard.press('ArrowUp')
  await expect(palette.getByRole('menuitem', { name: /Open terminal/ })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(palette).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Project terminal', exact: true }).locator('canvas')).toBeVisible()
  await page.keyboard.press('Control+t')
  await expect(page.getByRole('region', { name: 'Project terminal', exact: true })).toBeHidden()
  await page.keyboard.press('Control+t')
  await expect(page.getByRole('region', { name: 'Project terminal', exact: true })).toBeVisible()
})

test('unavailable thinking and project choices stay keyboard reachable while terminal is skipped', async ({ page }) => {
  await seedComposer(page, 'opencode', 'provider/model')
  await page.goto(`${fixture}?noProjects`)
  const palette = await openPalette(page)
  const terminal = palette.getByRole('menuitem', { name: /Open terminal/ })
  await expect(terminal).toBeDisabled()

  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Choose thinking' }).getByRole('status'))
    .toHaveText('This model has no thinking options.')
  await page.keyboard.press('Escape')
  await expect(palette.getByRole('menuitem', { name: /Change thinking/ })).toBeFocused()

  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Choose project' }).getByRole('status'))
    .toHaveText('No projects available.')
  await page.keyboard.press('Escape')
  await page.keyboard.press('ArrowDown')
  await expect(palette.getByRole('menuitem', { name: /Toggle caffeine mode/ })).toBeFocused()
  await page.keyboard.press('Escape')
})

test('search ranks a partial match first and activates it with ArrowDown and Enter', async ({ page }) => {
  await page.goto(fixture)
  const palette = await openPalette(page)
  const search = palette.getByRole('searchbox', { name: 'Search commands' })

  await expect(search).toBeFocused()
  await search.pressSequentially('term')
  const results = palette.getByRole('menuitem')
  await expect(results).toHaveCount(1)
  await expect(results.first()).toHaveAccessibleName(/Open terminal/)

  await page.keyboard.press('ArrowDown')
  await expect(results.first()).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(palette).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Project terminal', exact: true }).locator('canvas')).toBeVisible()
})

test('search guards disabled matches, exposes its empty state, and resets when reopened', async ({ page }) => {
  await page.goto(`${fixture}?noProjects`)
  const palette = await openPalette(page)
  const search = palette.getByRole('searchbox', { name: 'Search commands' })

  await search.pressSequentially('terminal')
  const terminal = palette.getByRole('menuitem', { name: /Open terminal/ })
  await expect(terminal).toBeDisabled()
  await page.keyboard.press('ArrowDown')
  await expect(search).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(palette).toBeVisible()

  await search.fill('unmatched-query')
  await expect(palette.getByRole('status')).toHaveText('No commands found.')
  await expect(palette.getByRole('menuitem')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(palette).toHaveCount(0)

  const reopened = await openPalette(page)
  await expect(reopened.getByRole('searchbox', { name: 'Search commands' })).toHaveValue('')
  await expect(reopened.getByRole('menuitem')).toHaveCount(6)
})
