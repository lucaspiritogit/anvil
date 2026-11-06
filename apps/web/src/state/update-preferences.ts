import { create } from 'zustand'

export const UPDATE_CHECKS_STORAGE_KEY = 'anvil:update-checks-enabled'
export const UPDATE_SNOOZED_SHA_STORAGE_KEY = 'anvil:update-snoozed-sha'

const SHA_PATTERN = /^[0-9a-f]{40}$/

interface UpdatePreferencesState {
  checksEnabled: boolean
  snoozedSha: string | null
  setChecksEnabled: (enabled: boolean) => void
  snooze: (sha: string) => void
  clearSnooze: () => void
}

function read(key: string): string | null {
  try { return window.localStorage.getItem(key) } catch { return null }
}

function write(key: string, value: string): void {
  try { window.localStorage.setItem(key, value) } catch {}
}

function readSnoozedSha(): string | null {
  const value = read(UPDATE_SNOOZED_SHA_STORAGE_KEY)?.trim().toLowerCase() ?? ''
  return SHA_PATTERN.test(value) ? value : null
}

export const useUpdatePreferences = create<UpdatePreferencesState>((set) => ({
  checksEnabled: read(UPDATE_CHECKS_STORAGE_KEY) !== 'false',
  snoozedSha: readSnoozedSha(),
  setChecksEnabled: (enabled) => {
    write(UPDATE_CHECKS_STORAGE_KEY, String(enabled))
    set({ checksEnabled: enabled })
  },
  snooze: (sha) => {
    const value = sha.toLowerCase()
    if (!SHA_PATTERN.test(value)) return
    write(UPDATE_SNOOZED_SHA_STORAGE_KEY, value)
    set({ snoozedSha: value })
  },
  clearSnooze: () => {
    try { window.localStorage.removeItem(UPDATE_SNOOZED_SHA_STORAGE_KEY) } catch {}
    set({ snoozedSha: null })
  }
}))
