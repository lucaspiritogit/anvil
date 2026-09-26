import { createAnvilApi } from '@anvil/client-api'
import type { BrowserObservationState } from '@anvil/protocol/browser-observation'
import type { ProjectFolderSelection } from '@anvil/client-api'

function pickProjectFolder(): Promise<ProjectFolderSelection | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.webkitdirectory = true
    input.multiple = true
    input.style.display = 'none'
    document.body.append(input)

    const finish = (selection: ProjectFolderSelection | null): void => {
      input.remove()
      resolve(selection)
    }
    const fail = (message: string): void => {
      input.remove()
      reject(new Error(message))
    }

    input.addEventListener('cancel', () => finish(null), { once: true })
    input.addEventListener('change', () => {
      const files = Array.from(input.files ?? [])
      if (!files.length) {
        fail('Choose a folder that contains project files')
        return
      }

      const name = files[0].webkitRelativePath.split('/')[0]
      if (!name || files.some((file) => !file.webkitRelativePath.startsWith(`${name}/`))) {
        fail('The browser did not provide folder paths. Try another browser.')
        return
      }

      finish({
        name,
        entries: files.map((file) => ({
          path: file.webkitRelativePath.slice(name.length + 1),
          type: 'file' as const,
          size: file.size,
          read: async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())
        }))
      })
    }, { once: true })
    input.click()
  })
}

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
    pickProjectFolder,
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
