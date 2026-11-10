import { create } from 'zustand'

export const UPDATE_CHECKS_STORAGE_KEY = 'anvil:update-checks-enabled'
export const UPDATE_SNOOZED_SHA_STORAGE_KEY = 'anvil:update-snoozed-sha'

const UPDATE_KEY_PATTERN = /^(?:[0-9a-f]{40}|v\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?)$/

interface UpdatePreferencesState {
  checksEnabled: boolean
  snoozedUpdate: string | null
  setChecksEnabled: (enabled: boolean) => void
  snooze: (key: string) => void
  clearSnooze: () => void
}

function read(key: string): string | null {
  try { return window.localStorage.getItem(key) } catch { return null }
}

function write(key: string, value: string): void {
  try { window.localStorage.setItem(key, value) } catch {}
}

function readSnoozedUpdate(): string | null {
  const value = read(UPDATE_SNOOZED_SHA_STORAGE_KEY)?.trim().toLowerCase() ?? ''
  return UPDATE_KEY_PATTERN.test(value) ? value : null
}

export const useUpdatePreferences = create<UpdatePreferencesState>((set) => ({
  checksEnabled: read(UPDATE_CHECKS_STORAGE_KEY) !== 'false',
  snoozedUpdate: readSnoozedUpdate(),
  setChecksEnabled: (enabled) => {
    write(UPDATE_CHECKS_STORAGE_KEY, String(enabled))
    set({ checksEnabled: enabled })
  },
  snooze: (key) => {
    const value = key.toLowerCase()
    if (!UPDATE_KEY_PATTERN.test(value)) return
    write(UPDATE_SNOOZED_SHA_STORAGE_KEY, value)
    set({ snoozedUpdate: value })
  },
  clearSnooze: () => {
    try { window.localStorage.removeItem(UPDATE_SNOOZED_SHA_STORAGE_KEY) } catch {}
    set({ snoozedUpdate: null })
  }
}))
