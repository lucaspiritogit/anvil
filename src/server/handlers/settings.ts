import type { WallpaperLibrary } from '../wallpapers'
import type { HandlerRegistry } from '../handler-registry'
import type { Store } from '../store'
import type { Settings, WorkspaceSettingsChange } from '../../shared/types'
import type { ConnectionsStatus, HeadlessAccessMode } from '../../shared/types'
import { BUILTIN_AGENTS, getAgent } from '../agents/registry'
import type { ServerAuth } from '../server-auth'
import type { TailscaleConnection } from '../tailscale'

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
  close(): Promise<void>
  initialize(): Promise<ConnectionsStatus>
  activate(workspaceId: string): Promise<ConnectionsStatus>
  status(workspaceId?: string): Promise<ConnectionsStatus>
}

export function registerConnectionsHandlers(
  ipc: HandlerRegistry,
  store: Store,
  auth: ServerAuth,
  rebind: (allowOtherDevices: boolean) => Promise<void>,
  changed: (workspaceId: string, status: ConnectionsStatus) => void = () => {},
  tailscale?: TailscaleConnection,
  headlessAccess?: HeadlessAccessMode
): ConnectionsController {
  let allowOtherDevices = false
  let desiredAllowOtherDevices = false
  let desiredTailscaleHttps = false
  let closed = false
  let pending = false
  let queuedTransitions = 0
  let lastError: string | undefined
  let transitions = Promise.resolve()

  const saveConnectionSettings = (workspaceId: string, patch: Partial<Pick<Settings, 'allowOtherDevices' | 'tailscaleHttps'>>): void => {
    // CLI access stays fixed for this process, including across workspace changes.
    // Leave saved desktop connection preferences intact.
    if (!headlessAccess) store.setSettings(patch, workspaceId)
  }

  const passwordConfigured = async (): Promise<boolean> => {
    if (headlessAccess === 'tailscale') return false
    return (await auth.status()).configured
  }
  const snapshot = async (): Promise<ConnectionsStatus> => ({
    allowOtherDevices,
    ...(headlessAccess ? { headlessAccess } : {}),
    ...(tailscale?.status() ?? { tailscaleHttps: false }),
    passwordConfigured: await passwordConfigured(),
    pending,
    ...(lastError ? { error: lastError } : {})
  })
  const publish = async (workspaceId: string): Promise<ConnectionsStatus> => {
    const status = await snapshot()
    changed(workspaceId, status)
    return status
  }
  const unsubscribeTailscale = tailscale?.onStopped((message) => {
    if (closed) return
    const workspaceId = store.getActiveWorkspace().id
    desiredTailscaleHttps = false
    saveConnectionSettings(workspaceId, { tailscaleHttps: false })
    lastError = message
    void publish(workspaceId).catch((error) => console.error('Could not publish Tailscale status:', error))
  })
  const configureTailscale = async (workspaceId: string, requested: boolean): Promise<void> => {
    try {
      if (requested && !tailscale) throw new Error('Tailscale HTTPS is unavailable in this server.')
      await tailscale?.configure(requested)
    } catch (error) {
      desiredTailscaleHttps = false
      saveConnectionSettings(workspaceId, { tailscaleHttps: false })
      lastError = error instanceof Error ? error.message : 'Could not configure Tailscale HTTPS.'
    }
  }
  const enqueue = (workspaceId: string, requested: boolean, requestedTailscale: boolean): Promise<void> => {
    transitions = transitions.catch(() => {}).then(async () => {
      if (closed) return
      try {
        if (!requestedTailscale) await configureTailscale(workspaceId, false)
        await rebind(requested)
        allowOtherDevices = requested
        if (requestedTailscale) await configureTailscale(workspaceId, true)
      } catch (error) {
        allowOtherDevices = false
        desiredAllowOtherDevices = false
        desiredTailscaleHttps = false
        await configureTailscale(workspaceId, false)
        saveConnectionSettings(workspaceId, { allowOtherDevices: false, tailscaleHttps: false })
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
  ipc.handle('connections:configure', async ({ workspaceId, allowOtherDevices: requested, password, tailscaleHttps }, context) => {
    if (closed) throw new Error('Anvil server is closing.')
    if (pending) throw new Error('Connection settings are still changing. Try again when the change finishes.')
    if (store.getActiveWorkspace().id !== workspaceId) throw new Error('Workspace changed; reload Connections and try again.')
    if (headlessAccess === 'tailscale' || (headlessAccess === 'password' && (!requested || tailscaleHttps === true))) {
      throw new Error('Connection access is managed by the headless startup command. Restart with the other command to change access.')
    }
    if (password !== undefined) await auth.setPassword(password)
    if (requested && !await passwordConfigured()) throw new Error('Set a valid server password before allowing other devices.')

    const requestedTailscale = !headlessAccess && requested && (tailscaleHttps ?? desiredTailscaleHttps)
    saveConnectionSettings(workspaceId, { allowOtherDevices: requested, tailscaleHttps: requestedTailscale })
    lastError = undefined
    if (requested !== desiredAllowOtherDevices || requestedTailscale !== desiredTailscaleHttps) {
      desiredAllowOtherDevices = requested
      desiredTailscaleHttps = requestedTailscale
      queuedTransitions += 1
      pending = true
      context.deferUntilResponse(() => enqueue(workspaceId, requested, requestedTailscale))
    } else {
      changed(workspaceId, await snapshot())
    }
    return snapshot()
  })

  const activateNow = async (workspaceId: string): Promise<ConnectionsStatus> => {
    const settings = store.getSettings(workspaceId)
    const requested = headlessAccess ? headlessAccess === 'password' : settings.allowOtherDevices
    const requestedTailscale = headlessAccess ? headlessAccess === 'tailscale' : requested && settings.tailscaleHttps
    desiredAllowOtherDevices = requested
    desiredTailscaleHttps = requestedTailscale
    lastError = undefined
    if (!requestedTailscale) await configureTailscale(workspaceId, false)
    if (headlessAccess !== 'tailscale' && (requested || requestedTailscale) && !await passwordConfigured()) {
      saveConnectionSettings(workspaceId, { allowOtherDevices: false, tailscaleHttps: false })
      desiredAllowOtherDevices = false
      desiredTailscaleHttps = false
      await configureTailscale(workspaceId, false)
      lastError = 'The stored server password is missing or invalid; remote access was disabled.'
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
    try {
      if (requested !== allowOtherDevices) await rebind(requested)
      allowOtherDevices = requested
      if (requestedTailscale) await configureTailscale(workspaceId, true)
    } catch (error) {
      saveConnectionSettings(workspaceId, { allowOtherDevices: false, tailscaleHttps: false })
      desiredAllowOtherDevices = false
      desiredTailscaleHttps = false
      allowOtherDevices = false
      await configureTailscale(workspaceId, false)
      lastError = error instanceof Error ? error.message : 'Could not change server connection mode.'
    }
    return publish(workspaceId)
  }
  const activate = (workspaceId: string): Promise<ConnectionsStatus> => {
    queuedTransitions += 1
    pending = true
    const result = transitions.catch(() => {}).then(async () => {
      if (closed) return snapshot()
      try {
        await activateNow(workspaceId)
      } finally {
        queuedTransitions -= 1
        pending = queuedTransitions > 0
      }
      return publish(workspaceId)
    })
    transitions = result.then(() => {}, () => {})
    return result
  }

  return {
    async close() {
      closed = true
      unsubscribeTailscale?.()
      await tailscale?.close()
      await transitions.catch(() => {})
    },
    initialize: () => activate(store.getActiveWorkspace().id),
    activate,
    status(workspaceId) {
      store.getSettings(workspaceId)
      return snapshot()
    }
  }
}
