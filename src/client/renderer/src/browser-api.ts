import { createAnvilApi } from '../../preload/api'

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
    pickProject: async () => window.prompt('Project folder on the computer running Anvil:')?.trim() || null,
    pickWallpaper: async () => window.prompt('Image path on the computer running Anvil:')?.trim() || null,
    openPath: async (path) => {
      window.prompt('Folder on the computer running Anvil:', path)
      return ''
    },
    openPullRequest: openUrl,
    openLoginUrl: openUrl
  })
}
