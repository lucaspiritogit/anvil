import type { WallpaperLibrary } from '../wallpapers'
import { BrowserWindow, dialog } from 'electron'
import type { RendererIpc } from '../renderer-security'
import type { Store } from '../store'
import type { Settings, WorkspaceSettingsChange } from '../../shared/types'
import { BUILTIN_AGENTS, getAgent } from '../agents/registry'

export function availableSettings(settings: Settings): Settings {
  if (getAgent(settings.defaultAgentId)) return settings
  // A removed agent may still be saved as the default. Keep the task composer usable.
  const fallback = BUILTIN_AGENTS[0]
  return { ...settings, defaultAgentId: fallback.id, defaultModel: fallback.defaultModel ?? '' }
}

export function registerSettingsHandlers(ipc: RendererIpc, store: Store, wallpapers: WallpaperLibrary | ((workspaceId: string) => WallpaperLibrary), changed: (change: WorkspaceSettingsChange) => void = () => {}): void {
  const library = (workspaceId?: string): WallpaperLibrary => typeof wallpapers === 'function'
    ? wallpapers(workspaceId ?? store.getActiveWorkspace().id) : wallpapers
  ipc.handle('wallpapers:directory', (_event, workspaceId) => library(workspaceId).directory)
  ipc.handle('wallpapers:list', (_event, workspaceId) => library(workspaceId).list())
  ipc.handle('wallpapers:import', async (event, workspaceId) => {
    const selectedLibrary = library(workspaceId)
    const window = BrowserWindow.fromWebContents(event.sender)
    const options: Electron.OpenDialogOptions = {
      title: 'Add wallpaper',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths.length) return null
    return selectedLibrary.importImage(result.filePaths[0])
  })
  ipc.handle('wallpapers:read', (_event, input) => typeof input === 'string'
    ? library().read(input) : library(input.workspaceId).read(input.id))
  ipc.handle('settings:get', (_event, workspaceId) => availableSettings(store.getSettings(workspaceId)))
  ipc.handle('settings:set', (_event, { workspaceId, patch }) => {
    if (patch.defaultAgentId !== undefined && !getAgent(patch.defaultAgentId)) throw new Error('Unknown agent')
    const settings = availableSettings(store.setSettings(patch, workspaceId))
    changed({ workspaceId, settings })
    return settings
  })
}
