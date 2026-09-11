import type { WallpaperLibrary } from '../wallpapers'
import type { HandlerRegistry } from '../handler-registry'
import type { Store } from '../store'
import type { Settings, WorkspaceSettingsChange } from '../../shared/types'
import type { ConnectionsStatus } from '../../shared/types'
import { BUILTIN_AGENTS, getAgent } from '../agents/registry'
import type { ServerAuth } from '../server-auth'

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

export interface ConnectionsController {
  initialize(): Promise<ConnectionsStatus>
  activate(workspaceId: string): Promise<ConnectionsStatus>
  status(workspaceId?: string): Promise<ConnectionsStatus>
}

export function registerConnectionsHandlers(
  ipc: HandlerRegistry,
  store: Store,
  auth: ServerAuth,
  rebind: (allowOtherDevices: boolean) => Promise<void>,
  changed: (workspaceId: string, status: ConnectionsStatus) => void = () => {}
): ConnectionsController {
  let allowOtherDevices = false
  let desiredAllowOtherDevices = false
  let pending = false
  let queuedTransitions = 0
  let lastError: string | undefined
  let transitions = Promise.resolve()

  const passwordConfigured = async (): Promise<boolean> => (await auth.status()).configured
  const snapshot = async (): Promise<ConnectionsStatus> => ({
    allowOtherDevices,
    passwordConfigured: await passwordConfigured(),
    pending,
    ...(lastError ? { error: lastError } : {})
  })
  const publish = async (workspaceId: string): Promise<ConnectionsStatus> => {
    const status = await snapshot()
    changed(workspaceId, status)
    return status
  }
  const enqueue = (workspaceId: string, requested: boolean): Promise<void> => {
    transitions = transitions.catch(() => {}).then(async () => {
      try {
        await rebind(requested)
        allowOtherDevices = requested
      } catch (error) {
        allowOtherDevices = false
        desiredAllowOtherDevices = false
        store.setSettings({ allowOtherDevices: false }, workspaceId)
        lastError = error instanceof Error ? error.message : 'Could not change server connection mode.'
      } finally {
        queuedTransitions -= 1
        pending = queuedTransitions > 0
        await publish(workspaceId)
      }
    })
    return transitions
  }

  ipc.handle('connections:status', (workspaceId) => {
    store.getSettings(workspaceId)
    return snapshot()
  })
  ipc.handle('connections:configure', async ({ workspaceId, allowOtherDevices: requested, password }, context) => {
    if (store.getActiveWorkspace().id !== workspaceId) throw new Error('Workspace changed; reload Connections and try again.')
    if (password !== undefined) await auth.setPassword(password)
    if (requested && !await passwordConfigured()) throw new Error('Set a valid server password before allowing other devices.')

    store.setSettings({ allowOtherDevices: requested }, workspaceId)
    lastError = undefined
    if (requested !== desiredAllowOtherDevices) {
      desiredAllowOtherDevices = requested
      queuedTransitions += 1
      pending = true
      context.deferUntilResponse(() => enqueue(workspaceId, requested))
    } else {
      changed(workspaceId, await snapshot())
    }
    return snapshot()
  })

  const activateNow = async (workspaceId: string): Promise<ConnectionsStatus> => {
    const requested = store.getSettings(workspaceId).allowOtherDevices
    desiredAllowOtherDevices = requested
    if (requested && !await passwordConfigured()) {
      store.setSettings({ allowOtherDevices: false }, workspaceId)
      desiredAllowOtherDevices = false
      lastError = 'The stored server password is missing or invalid; LAN access was disabled.'
      if (allowOtherDevices) {
        try {
          await rebind(false)
        } catch (error) {
          lastError = error instanceof Error ? error.message : 'Could not restore loopback access.'
        }
      }
      allowOtherDevices = false
      return publish(workspaceId)
    }
    if (requested === allowOtherDevices) return publish(workspaceId)
    try {
      await rebind(requested)
      allowOtherDevices = requested
      lastError = undefined
    } catch (error) {
      store.setSettings({ allowOtherDevices: false }, workspaceId)
      desiredAllowOtherDevices = false
      allowOtherDevices = false
      lastError = error instanceof Error ? error.message : 'Could not change server connection mode.'
    }
    return publish(workspaceId)
  }
  const activate = (workspaceId: string): Promise<ConnectionsStatus> => {
    const result = transitions.catch(() => {}).then(() => activateNow(workspaceId))
    transitions = result.then(() => {}, () => {})
    return result
  }

  return {
    initialize: () => activate(store.getActiveWorkspace().id),
    activate,
    status(workspaceId) {
      store.getSettings(workspaceId)
      return snapshot()
    }
  }
}
