import { useSyncExternalStore } from 'react'
import type { DesktopUpdateState } from '@anvil/protocol/desktop-updates'

let current: DesktopUpdateState | null | undefined
let started = false
const listeners = new Set<() => void>()

function publish(state: DesktopUpdateState): void {
  current = state
  for (const listener of listeners) listener()
}

function start(): void {
  if (started) return
  started = true
  const host = window.anvil.desktopUpdates
  if (!host) {
    current = null
    return
  }
  host.onChanged(publish)
  void host.state().then(publish, (error: unknown) => {
    console.warn('Could not read the desktop update state:', error)
    current = null
    for (const listener of listeners) listener()
  })
}

function subscribe(listener: () => void): () => void {
  start()
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function snapshot(): DesktopUpdateState | null | undefined {
  start()
  return current
}

export function desktopUpdatesActive(state: DesktopUpdateState | null | undefined): state is DesktopUpdateState {
  return Boolean(state && state.status !== 'unsupported')
}

export function desktopUpdatesCoverServer(state: DesktopUpdateState | null | undefined): boolean {
  return desktopUpdatesActive(state) && window.anvil.desktopUpdates?.managesServer === true
}

export function useDesktopUpdate(): DesktopUpdateState | null | undefined {
  return useSyncExternalStore(subscribe, snapshot)
}
