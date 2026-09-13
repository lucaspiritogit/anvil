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
  const configureTailscale = async (workspaceId: string, requested: boolean): Promise<string | undefined> => {
    try {
      if (requested && !tailscale) throw new Error('Tailscale HTTPS is unavailable in this server.')
      await tailscale?.configure(requested)
      return undefined
    } catch (error) {
      desiredTailscaleHttps = false
      saveConnectionSettings(workspaceId, { tailscaleHttps: false })
      return error instanceof Error ? error.message : 'Could not configure Tailscale HTTPS.'
    }
  }
  const applyModes = async (workspaceId: string, requested: boolean, requestedTailscale: boolean): Promise<void> => {
    const errors: string[] = []
    if (requested !== allowOtherDevices) {
      try {
        await rebind(requested)
        allowOtherDevices = requested
      } catch (error) {
        allowOtherDevices = false
        desiredAllowOtherDevices = false
        saveConnectionSettings(workspaceId, { allowOtherDevices: false })
        errors.push(error instanceof Error ? error.message : 'Could not change LAN access.')
      }
    }

    const tailscaleEnabled = tailscale?.status().tailscaleHttps ?? false
    if (requestedTailscale !== tailscaleEnabled) {
      const error = await configureTailscale(workspaceId, requestedTailscale)
      if (error) errors.push(error)
    }
    lastError = errors.length ? errors.join(' ') : undefined
  }
  const enqueue = (workspaceId: string, requested: boolean, requestedTailscale: boolean): Promise<void> => {
    transitions = transitions.catch(() => {}).then(async () => {
      if (closed) return
      try {
        await applyModes(workspaceId, requested, requestedTailscale)
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
    const requestedTailscale = headlessAccess === 'tailscale'
      ? true
      : headlessAccess
        ? false
        : tailscaleHttps ?? desiredTailscaleHttps
    if (headlessAccess) {
      throw new Error('Connection access is managed by the headless startup command. Restart with the other command to change access.')
    }
    if (password !== undefined) await auth.setPassword(password)
    if ((requested || requestedTailscale) && !await passwordConfigured()) {
      throw new Error('Set a valid server password before enabling LAN or Tailscale access.')
    }

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
    const requested = headlessAccess === 'lan' ? true : headlessAccess ? false : settings.allowOtherDevices
    const requestedTailscale = headlessAccess === 'tailscale' ? true : headlessAccess ? false : settings.tailscaleHttps
    desiredAllowOtherDevices = requested
    desiredTailscaleHttps = requestedTailscale
    lastError = undefined
    if (headlessAccess !== 'tailscale' && (requested || requestedTailscale) && !await passwordConfigured()) {
      saveConnectionSettings(workspaceId, { allowOtherDevices: false, tailscaleHttps: false })
      desiredAllowOtherDevices = false
      desiredTailscaleHttps = false
      await applyModes(workspaceId, false, false)
      lastError = lastError
        ? `The stored server password is missing or invalid; remote access was disabled. ${lastError}`
        : 'The stored server password is missing or invalid; remote access was disabled.'
      return publish(workspaceId)
    }
    await applyModes(workspaceId, requested, requestedTailscale)
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
