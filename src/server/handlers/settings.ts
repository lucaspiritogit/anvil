import type { WallpaperLibrary } from '../wallpapers'
import type { HandlerRegistry } from '../handler-registry'
import type { Store } from '../store'
import type { Settings, WorkspaceSettingsChange } from '../../shared/types'
import { BUILTIN_AGENTS, getAgent } from '../agents/registry'

export function availableSettings(settings: Settings): Settings {
  if (getAgent(settings.defaultAgentId)) return settings
  // A removed agent may still be saved as the default. Keep the task composer usable.
  const fallback = BUILTIN_AGENTS[0]
  return { ...settings, defaultAgentId: fallback.id, defaultModel: fallback.defaultModel ?? '' }
}

export function registerSettingsHandlers(ipc: HandlerRegistry, store: Store, wallpapers: WallpaperLibrary | ((workspaceId: string) => WallpaperLibrary), changed: (change: WorkspaceSettingsChange) => void = () => {}): void {
  const library = (workspaceId?: string): WallpaperLibrary => typeof wallpapers === 'function'
    ? wallpapers(workspaceId ?? store.getActiveWorkspace().id) : wallpapers
  ipc.handle('wallpapers:directory', (workspaceId) => library(workspaceId).directory)
  ipc.handle('wallpapers:list', (workspaceId) => library(workspaceId).list())
  ipc.handle('wallpapers:import', ({ path, workspaceId }) => library(workspaceId).importImage(path))
  ipc.handle('wallpapers:read', (input) => typeof input === 'string'
    ? library().read(input) : library(input.workspaceId).read(input.id))
  ipc.handle('settings:get', (workspaceId) => availableSettings(store.getSettings(workspaceId)))
  ipc.handle('settings:set', ({ workspaceId, patch }) => {
    if (patch.defaultAgentId !== undefined && !getAgent(patch.defaultAgentId)) throw new Error('Unknown agent')
    const settings = availableSettings(store.setSettings(patch, workspaceId))
    changed({ workspaceId, settings })
    return settings
  })
}
