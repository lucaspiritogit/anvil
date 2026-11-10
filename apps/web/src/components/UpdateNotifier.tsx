import type { JSX } from 'react'
import { useEffect } from 'react'
import { ANVIL_RELEASES_URL, ANVIL_REPOSITORY_URL, isAnvilRepositoryUrl } from '@anvil/protocol/external-links'
import type { DesktopUpdateState } from '@anvil/protocol/desktop-updates'
import { getUpdateChecker, useUpdateCheck } from '../hooks/use-update-check'
import { desktopUpdatesActive, desktopUpdatesCoverServer, useDesktopUpdate } from '../hooks/use-desktop-update'
import { dismissToast, showToast } from '../state/toasts'
import { useUpdatePreferences } from '../state/update-preferences'
import { updateKey, type UpdateCheckState } from '../update-check'

export const UPDATE_TOAST_ID = 'anvil-update-available'
export const DESKTOP_UPDATE_TOAST_ID = 'anvil-desktop-update-ready'
export const DESKTOP_UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60_000

export type ManualUpdateCheckResult =
  | { kind: 'update-available'; aheadBy: number; version: string | null }
  | { kind: 'up-to-date' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }

let shownKey: string | null = null
let shownDesktopVersion: string | null = null
let dismissedDesktopVersion: string | null = null

function openRepositoryUrl(url: string): void {
  void window.anvil.app.openRepositoryUrl(url).catch((error: unknown) => {
    console.warn('Could not open the Anvil repository:', error)
  })
}

export function updateToastTitle(aheadBy: number, version: string | null = null): string {
  if (version) return `Anvil ${version} is available`
  return `A new version of Anvil is available (${aheadBy} new ${aheadBy === 1 ? 'commit' : 'commits'})`
}

function connectedToRemoteServer(): boolean {
  return window.anvil.desktopUpdates?.managesServer === false
}

function presentUpdateToast(state: UpdateCheckState, key: string): void {
  shownKey = key
  const remote = connectedToRemoteServer()
  if (state.latestVersion) {
    const releaseUrl = state.compareUrl && isAnvilRepositoryUrl(state.compareUrl) ? state.compareUrl : ANVIL_RELEASES_URL
    showToast({
      id: UPDATE_TOAST_ID,
      title: updateToastTitle(0, state.latestVersion),
      body: remote ? 'A new Anvil server release is available. Update the server to get it.' : 'Download the new release to update.',
      persistent: true,
      actions: [
        { label: 'View release', onClick: () => openRepositoryUrl(releaseUrl), dismiss: false },
        { label: 'Later', onClick: () => useUpdatePreferences.getState().snooze(key) }
      ]
    })
    return
  }
  const changesUrl = state.compareUrl && isAnvilRepositoryUrl(state.compareUrl)
    ? state.compareUrl
    : `${ANVIL_REPOSITORY_URL}/compare/${state.buildSha}...${key}`
  showToast({
    id: UPDATE_TOAST_ID,
    title: updateToastTitle(state.aheadBy),
    body: remote ? 'New commits landed on main. Update the Anvil server to get them.' : 'Update to get the latest changes from main.',
    persistent: true,
    actions: [
      ...(remote ? [] : [{ label: 'Update', onClick: () => openRepositoryUrl(ANVIL_RELEASES_URL), dismiss: false }]),
      { label: 'View changes', onClick: () => openRepositoryUrl(changesUrl), dismiss: false },
      { label: 'Later', onClick: () => useUpdatePreferences.getState().snooze(key) }
    ]
  })
}

function hideUpdateToast(): void {
  shownKey = null
  dismissToast(UPDATE_TOAST_ID)
}

export async function checkForUpdatesNow(): Promise<ManualUpdateCheckResult> {
  const checker = getUpdateChecker()
  if (checker.getSnapshot().status === 'disabled') return { kind: 'unavailable' }
  const before = checker.getSnapshot().lastCheckedAt
  await checker.check()
  const state = checker.getSnapshot()
  if (state.error && state.lastCheckedAt !== before) return { kind: 'error', message: state.error }
  const key = updateKey(state)
  if (state.status !== 'update-available' || !key) {
    hideUpdateToast()
    return { kind: 'up-to-date' }
  }
  const preferences = useUpdatePreferences.getState()
  if (preferences.snoozedUpdate === key) preferences.clearSnooze()
  presentUpdateToast(state, key)
  return { kind: 'update-available', aheadBy: state.aheadBy, version: state.latestVersion }
}

export function installDesktopUpdate(): void {
  void window.anvil.desktopUpdates?.install().catch((error: unknown) => {
    console.warn('Could not install the Anvil update:', error)
  })
}

function presentDesktopUpdateToast(version: string): void {
  shownDesktopVersion = version
  showToast({
    id: DESKTOP_UPDATE_TOAST_ID,
    title: `Anvil ${version} is ready to install`,
    body: 'Restart Anvil to finish updating. Otherwise it installs the next time you quit.',
    persistent: true,
    actions: [
      { label: 'Restart now', onClick: installDesktopUpdate, dismiss: false },
      { label: 'Later', onClick: () => { dismissedDesktopVersion = version } }
    ]
  })
}

function hideDesktopUpdateToast(): void {
  shownDesktopVersion = null
  dismissToast(DESKTOP_UPDATE_TOAST_ID)
}

function UpdateChecks(): null {
  const state = useUpdateCheck()
  const snoozedUpdate = useUpdatePreferences((s) => s.snoozedUpdate)
  const { status } = state
  const key = updateKey(state)

  useEffect(() => {
    if (status !== 'update-available' || !key || key === snoozedUpdate) {
      if (status !== 'checking') hideUpdateToast()
      return
    }
    if (shownKey === key) return
    presentUpdateToast(state, key)
  }, [state, status, key, snoozedUpdate])

  useEffect(() => hideUpdateToast, [])

  return null
}

function DesktopUpdateChecks({ state }: { state: DesktopUpdateState }): null {
  useEffect(() => {
    const host = window.anvil.desktopUpdates
    if (!host) return
    const check = (): void => {
      void host.check().catch((error: unknown) => console.warn('Could not check for Anvil updates:', error))
    }
    check()
    const timer = window.setInterval(check, DESKTOP_UPDATE_CHECK_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const version = state.status === 'downloaded' ? state.version : null
    if (!version || version === dismissedDesktopVersion) {
      hideDesktopUpdateToast()
      return
    }
    if (shownDesktopVersion !== version) presentDesktopUpdateToast(version)
  }, [state.status, state.version])

  useEffect(() => hideDesktopUpdateToast, [])

  return null
}

export function UpdateNotifier(): JSX.Element | null {
  const enabled = useUpdatePreferences((s) => s.checksEnabled)
  const desktop = useDesktopUpdate()
  if (!enabled || desktop === undefined) return null
  return (
    <>
      {desktopUpdatesActive(desktop) && <DesktopUpdateChecks state={desktop} />}
      {!desktopUpdatesCoverServer(desktop) && <UpdateChecks />}
    </>
  )
}
