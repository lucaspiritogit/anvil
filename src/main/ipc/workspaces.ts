import type { WorkspaceSnapshot } from '../../shared/types'
import type { RendererIpc } from '../renderer-security'
import type { Store } from '../store'
import { availableSettings } from './settings'

export function workspaceSnapshot(store: Store): WorkspaceSnapshot {
  const workspace = store.getActiveWorkspace()
  return {
    workspaces: store.getWorkspaces(), workspace,
    settings: availableSettings(store.getSettings(workspace.id)),
    preferences: store.getWorkspacePreferences(workspace.id),
    projects: store.getProjects(), tasks: store.getTasks(workspace.id)
  }
}

export function registerWorkspaceHandlers(
  ipc: RendererIpc,
  store: Store,
  broadcast: (channel: string, payload: unknown) => void,
  rename: (workspaceId: string, name: string) => ReturnType<Store['renameWorkspace']> | Promise<ReturnType<Store['renameWorkspace']>> = (workspaceId, name) => store.renameWorkspace(workspaceId, name)
): void {
  ipc.handle('workspaces:list', () => store.getWorkspaces())
  ipc.handle('workspaces:snapshot', () => workspaceSnapshot(store))
  ipc.handle('workspaces:create', (_event, name) => {
    const workspace = store.createWorkspace(name)
    broadcast('workspaces:changed', store.getWorkspaces())
    return workspace
  })
  ipc.handle('workspaces:rename', async (_event, { workspaceId, name }) => {
    const workspace = await rename(workspaceId, name)
    broadcast('workspaces:changed', store.getWorkspaces())
    return workspace
  })
  ipc.handle('workspaces:select', (_event, workspaceId) => {
    store.selectWorkspace(workspaceId)
    const snapshot = workspaceSnapshot(store)
    broadcast('workspaces:selected', snapshot)
    return snapshot
  })
  ipc.handle('workspaces:preferences:get', (_event, workspaceId) => store.getWorkspacePreferences(workspaceId))
  ipc.handle('workspaces:preferences:set', (_event, { workspaceId, patch }) => {
    if (patch.lastProjectId && !store.getProjects(workspaceId).some((project) => project.id === patch.lastProjectId)) throw new Error('Project not found')
    const preferences = store.setWorkspacePreferences(patch, workspaceId)
    broadcast('workspaces:preferences:changed', { workspaceId, preferences })
    return preferences
  })
  ipc.handle('workspaces:composer:import', (_event, composer) => {
    const preferences = store.importLegacyComposerPreferences(composer)
    broadcast('workspaces:preferences:changed', { workspaceId: 'default', preferences })
    return preferences
  })
}
