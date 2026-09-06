import { ipcMain } from 'electron'
import type { Store } from '../store'
import type { Settings } from '../../shared/types'

export function registerSettingsHandlers(store: Store): void {
  ipcMain.handle('settings:get', () => store.getSettings())
  ipcMain.handle('settings:set', (_event, patch: Partial<Settings>) => store.setSettings(patch))
}
