import type { WallpaperLibrary } from '../wallpapers'
import type { RendererIpc } from '../renderer-security'
import type { Store } from '../store'
import type { Settings } from '../../shared/types'
import { BUILTIN_AGENTS, getAgent } from '../agents/registry'

function availableSettings(settings: Settings): Settings {
  if (getAgent(settings.defaultAgentId)) return settings
  // A removed agent may still be saved as the default. Keep the task composer usable.
  const fallback = BUILTIN_AGENTS[0]
  return { ...settings, defaultAgentId: fallback.id, defaultModel: fallback.defaultModel ?? '' }
}

export function registerSettingsHandlers(ipc: RendererIpc, store: Store, wallpapers: WallpaperLibrary, changed: (settings: Settings) => void = () => {}): void {
  ipc.handle('wallpapers:directory', () => wallpapers.directory)
  ipc.handle('wallpapers:list', () => wallpapers.list())
  ipc.handle('wallpapers:read', (_event, id) => wallpapers.read(id))
  ipc.handle('settings:get', () => availableSettings(store.getSettings()))
  ipc.handle('settings:set', (_event, patch) => {
    if (patch.defaultAgentId !== undefined && !getAgent(patch.defaultAgentId)) throw new Error('Unknown agent')
    const settings = availableSettings(store.setSettings(patch))
    changed(settings)
    return settings
  })
}
