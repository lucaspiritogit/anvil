import type { Page } from '@playwright/test'

/** Exercise existing flows as a returning user with an explicit saved selection. */
export async function restoreComposerSelection(page: Page): Promise<void> {
  await page.addInitScript(() => {
    if (localStorage.getItem('anvil-composer-preferences-v2')) return
    localStorage.setItem('anvil-composer-preferences-v2', JSON.stringify({
      state: {
        agentId: 'codex',
        modelsByAgent: { codex: 'gpt-5', opencode: 'provider/model' },
        reasoningByAgentModel: {}
      },
      version: 0
    }))
  })
}
