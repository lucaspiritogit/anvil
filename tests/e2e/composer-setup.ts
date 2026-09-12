import type { Page } from '@playwright/test'

/** Exercise existing flows as a returning user with an explicit saved selection. */
export async function restoreComposerSelection(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (localStorage.getItem('fixture:preferences')) return
    localStorage.setItem('fixture:preferences', JSON.stringify({
      default: {
        composer: {
          agentId: 'codex',
          modelsByAgent: { codex: 'gpt-5', opencode: 'provider/model' },
          reasoningByAgentModel: {}
        },
        lastProjectId: null
      }
    }))
  })
}

/** Browse a provider without committing a model or dismissing the shared dialog. */
export async function browseProvider(trigger: import('@playwright/test').Locator, id: string) {
  await trigger.click()
  const dialog = trigger.page().getByRole('dialog', { name: 'Choose model', exact: true })
  await dialog.getByRole('navigation', { name: 'Providers' })
    .getByRole('button', { name: id === 'codex' ? 'Codex' : 'OpenCode', exact: true }).click()
  return dialog
}

/** Select the provider's remembered model, or explicitly choose its first listed model. */
export async function chooseProvider(trigger: import('@playwright/test').Locator, id: string, model?: string): Promise<void> {
  const dialog = await browseProvider(trigger, id)
  const models = dialog.getByRole('group', { name: 'Models', exact: true })
  if (model) await models.getByTitle(model, { exact: true }).click()
  else {
    const saved = models.locator('button[aria-pressed="true"]')
    await (await saved.count() ? saved : models.getByRole('button').first()).click()
  }
}

export async function chooseBranch(trigger: import('@playwright/test').Locator, name: string): Promise<void> {
  await trigger.click()
  await trigger.page().getByRole('dialog', { name: 'Choose branch', exact: true })
    .getByRole('button', { name, exact: true }).click()
}
