import type { JSX } from 'react'
import { useEffect } from 'react'
import { ANVIL_RELEASES_URL, ANVIL_REPOSITORY_URL, isAnvilRepositoryUrl } from '@anvil/protocol/external-links'
import { getUpdateChecker, useUpdateCheck } from '../hooks/use-update-check'
import { dismissToast, showToast } from '../state/toasts'
import { useUpdatePreferences } from '../state/update-preferences'
import type { UpdateCheckState } from '../update-check'

export const UPDATE_TOAST_ID = 'anvil-update-available'

export type ManualUpdateCheckResult =
  | { kind: 'update-available'; aheadBy: number }
  | { kind: 'up-to-date' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }

let shownSha: string | null = null

function openRepositoryUrl(url: string): void {
  void window.anvil.app.openRepositoryUrl(url).catch((error: unknown) => {
    console.warn('Could not open the Anvil repository:', error)
  })
}

export function updateToastTitle(aheadBy: number): string {
  return `A new version of Anvil is available (${aheadBy} new ${aheadBy === 1 ? 'commit' : 'commits'})`
}

function presentUpdateToast(state: UpdateCheckState, latestSha: string): void {
  shownSha = latestSha
  const changesUrl = state.compareUrl && isAnvilRepositoryUrl(state.compareUrl)
    ? state.compareUrl
    : `${ANVIL_REPOSITORY_URL}/compare/${state.buildSha}...${latestSha}`
  showToast({
    id: UPDATE_TOAST_ID,
    title: updateToastTitle(state.aheadBy),
    body: 'Update to get the latest changes from main.',
    persistent: true,
    actions: [
      { label: 'Update', onClick: () => openRepositoryUrl(ANVIL_RELEASES_URL), dismiss: false },
      { label: 'View changes', onClick: () => openRepositoryUrl(changesUrl), dismiss: false },
      { label: 'Later', onClick: () => useUpdatePreferences.getState().snooze(latestSha) }
    ]
  })
}

function hideUpdateToast(): void {
  shownSha = null
  dismissToast(UPDATE_TOAST_ID)
}

export async function checkForUpdatesNow(): Promise<ManualUpdateCheckResult> {
  const checker = getUpdateChecker()
  if (checker.getSnapshot().status === 'disabled') return { kind: 'unavailable' }
  const before = checker.getSnapshot().lastCheckedAt
  await checker.check()
  const state = checker.getSnapshot()
  if (state.error && state.lastCheckedAt !== before) return { kind: 'error', message: state.error }
  if (state.status !== 'update-available' || !state.latestSha) {
    hideUpdateToast()
    return { kind: 'up-to-date' }
  }
  const preferences = useUpdatePreferences.getState()
  if (preferences.snoozedSha === state.latestSha) preferences.clearSnooze()
  presentUpdateToast(state, state.latestSha)
  return { kind: 'update-available', aheadBy: state.aheadBy }
}

function UpdateChecks(): null {
  const state = useUpdateCheck()
  const snoozedSha = useUpdatePreferences((s) => s.snoozedSha)
  const { status, latestSha } = state

  useEffect(() => {
    if (status !== 'update-available' || !latestSha || latestSha === snoozedSha) {
      if (status !== 'checking') hideUpdateToast()
      return
    }
    if (shownSha === latestSha) return
    presentUpdateToast(state, latestSha)
  }, [state, status, latestSha, snoozedSha])

  useEffect(() => hideUpdateToast, [])

  return null
}

export function UpdateNotifier(): JSX.Element | null {
  const enabled = useUpdatePreferences((s) => s.checksEnabled)
  return enabled ? <UpdateChecks /> : null
}
