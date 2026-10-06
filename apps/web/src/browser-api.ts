import { createAnvilApi } from '@anvil/client-api'
import type { BrowserObservationState } from '@anvil/protocol/browser-observation'

async function openUrl(value: string): Promise<void> {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Invalid external URL')
  }
  window.open(url.href, '_blank', 'noopener,noreferrer')
}

// Electron supplies its bridge before this module runs. Browsers use the same
// API over the authenticated origin that served the page.
if (!window.anvil) {
  window.anvil = createAnvilApi(window.location.origin, {
    platform: /Mac|iPhone|iPad/.test(navigator.platform) ? 'darwin' : 'linux',
    onSettingsOpen: () => () => {},
    pickWallpaper: async () => window.prompt('Image path on the computer running Anvil:')?.trim() || null,
    openPath: async (path) => {
      window.prompt('Folder on the computer running Anvil:', path)
      return ''
    },
    openPullRequest: openUrl,
    openLoginUrl: openUrl,
    browserState: async (taskId): Promise<BrowserObservationState> => ({ taskId, open: false, viewport: 'desktop' }),
    browserLayout: async () => {},
    browserViewport: async ({ taskId, viewport }): Promise<BrowserObservationState> => ({ taskId, open: false, viewport }),
    onBrowserChanged: () => () => {}
  })
}
