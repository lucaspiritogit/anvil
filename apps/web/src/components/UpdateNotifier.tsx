import type { JSX } from 'react'
import { useEffect } from 'react'
import { ANVIL_RELEASES_URL } from '@anvil/protocol/external-links'
import type { DesktopUpdateState } from '@anvil/protocol/desktop-updates'
import type { ServerUpdateState } from '@anvil/protocol/server-updates'
import { getUpdateChecker, useUpdateCheck } from '../hooks/use-update-check'
import { desktopUpdatesActive, desktopUpdatesCoverServer, useDesktopUpdate } from '../hooks/use-desktop-update'
import { dismissToast, showToast } from '../state/toasts'
import { useUpdatePreferences } from '../state/update-preferences'
import { updateKey } from '../update-check'

export const UPDATE_TOAST_ID = 'anvil-update-available'
export const DESKTOP_UPDATE_TOAST_ID = 'anvil-desktop-update-ready'
export const DESKTOP_UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60_000

export type ManualUpdateCheckResult =
  | { kind: 'update-available'; version: string }
  | { kind: 'up-to-date' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }

let shownSignature: string | null = null
let shownDesktopVersion: string | null = null
let dismissedDesktopVersion: string | null = null
let installError: string | null = null

function openRepositoryUrl(url: string): void {
  void window.anvil.app.openRepositoryUrl(url).catch((error: unknown) => {
    console.warn('Could not open the Anvil repository:', error)
  })
}

export function updateToastTitle(version: string): string {
  return `Anvil ${version} is available`
}

function connectedToRemoteServer(): boolean {
  return window.anvil.desktopUpdates?.managesServer === false
}

function installServerUpdate(): void {
  installError = null
  void window.anvil.app.serverUpdates.install().catch((error: unknown) => {
    installError = error instanceof Error ? error.message : String(error)
    shownSignature = null
    void getUpdateChecker().check(true)
  })
}

function presentProgressToast(server: ServerUpdateState): void {
  const version = server.latestVersion ?? ''
  const signature = `progress|${version}|${server.phase}|${server.progress}`
  if (shownSignature === signature) return
  shownSignature = signature
  const body = server.phase === 'downloading'
    ? `Downloading the update${server.progress === null ? '…' : ` (${Math.round(server.progress)}%)`}`
    : server.phase === 'installing' ? 'Installing the update…'
    : 'Restarting the Anvil server. This page reloads when it is back.'
  showToast({ id: UPDATE_TOAST_ID, title: `Updating Anvil to ${version}`.trim(), body, persistent: true, dismissible: false })
}

function presentUpdateToast(server: ServerUpdateState, key: string): void {
  const version = server.latestVersion ?? ''
  const error = server.error ?? installError
  const signature = `available|${key}|${server.installable}|${error}`
  if (shownSignature === signature) return
  shownSignature = signature
  const body = error ? `The update could not be installed: ${error}`
    : server.installable ? 'Updating restarts the Anvil server and reloads this page. Agents that are still running are interrupted.'
    : connectedToRemoteServer() ? 'A new Anvil server release is available. Update the server to get it.'
    : 'Download the new release to update.'
  showToast({
    id: UPDATE_TOAST_ID,
    title: updateToastTitle(version),
    body,
    persistent: true,
    actions: [
      ...(server.installable ? [{ label: error ? 'Try again' : 'Update and restart', onClick: installServerUpdate, dismiss: false }] : []),
      { label: 'View release', onClick: () => openRepositoryUrl(ANVIL_RELEASES_URL), dismiss: false },
      { label: 'Later', onClick: () => useUpdatePreferences.getState().snooze(key) }
    ]
  })
}

function hideUpdateToast(): void {
  shownSignature = null
  dismissToast(UPDATE_TOAST_ID)
}

export async function checkForUpdatesNow(): Promise<ManualUpdateCheckResult> {
  const checker = getUpdateChecker()
  if (checker.getSnapshot().status === 'disabled') return { kind: 'unavailable' }
  const before = checker.getSnapshot().lastCheckedAt
  await checker.check(true)
  const state = checker.getSnapshot()
  if (state.error && state.lastCheckedAt !== before) return { kind: 'error', message: state.error }
  const key = updateKey(state)
  if (!state.server || !key) {
    hideUpdateToast()
    return { kind: 'up-to-date' }
  }
  const preferences = useUpdatePreferences.getState()
  if (preferences.snoozedUpdate === key) preferences.clearSnooze()
  if (state.server.phase === 'idle') presentUpdateToast(state.server, key)
  return { kind: 'update-available', version: state.server.latestVersion ?? '' }
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
  const { server, status } = state
  const key = updateKey(state)

  useEffect(() => {
    if (server && server.phase !== 'idle') {
      presentProgressToast(server)
      return
    }
    if (!server || !key || key === snoozedUpdate) {
      if (status !== 'checking') hideUpdateToast()
      return
    }
    presentUpdateToast(server, key)
  }, [server, status, key, snoozedUpdate])

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
