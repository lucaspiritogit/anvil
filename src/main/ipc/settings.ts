import { ipcMain } from 'electron'
import type { Store } from '../store'
import type { Settings } from '../../shared/types'
import { BUILTIN_AGENTS, getAgent } from '../agents/registry'

function availableSettings(settings: Settings): Settings {
  if (getAgent(settings.defaultAgentId)) return settings
  // A removed agent may still be saved as the default. Keep the task composer usable.
  const fallback = BUILTIN_AGENTS[0]
  return { ...settings, defaultAgentId: fallback.id, defaultModel: fallback.defaultModel ?? '' }
}

export function registerSettingsHandlers(store: Store): void {
  ipcMain.handle('settings:get', () => availableSettings(store.getSettings()))
  ipcMain.handle('settings:set', (_event, patch: Partial<Settings>) => availableSettings(store.setSettings(patch)))
}
