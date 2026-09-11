import type { WorkspaceSnapshot } from '../../shared/types'
import type { HandlerRegistry } from '../handler-registry'
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
  ipc: HandlerRegistry,
  store: Store,
  broadcast: (channel: string, payload: unknown) => void,
  rename: (workspaceId: string, name: string) => ReturnType<Store['renameWorkspace']> | Promise<ReturnType<Store['renameWorkspace']>> = (workspaceId, name) => store.renameWorkspace(workspaceId, name),
  beforeSelect: () => Promise<void> = async () => {}
): void {
  ipc.handle('workspaces:list', () => store.getWorkspaces())
  ipc.handle('workspaces:snapshot', () => workspaceSnapshot(store))
  ipc.handle('workspaces:create', (name) => {
    const workspace = store.createWorkspace(name)
    broadcast('workspaces:changed', store.getWorkspaces())
    return workspace
  })
  ipc.handle('workspaces:rename', async ({ workspaceId, name }) => {
    const workspace = await rename(workspaceId, name)
    broadcast('workspaces:changed', store.getWorkspaces())
    return workspace
  })
  ipc.handle('workspaces:select', async (workspaceId) => {
    if (!store.getWorkspaces().some((workspace) => workspace.id === workspaceId)) throw new Error('Workspace not found')
    await beforeSelect()
    store.selectWorkspace(workspaceId)
    const snapshot = workspaceSnapshot(store)
    broadcast('workspaces:selected', snapshot)
    return snapshot
  })
  ipc.handle('workspaces:preferences:get', (workspaceId) => store.getWorkspacePreferences(workspaceId))
  ipc.handle('workspaces:preferences:set', ({ workspaceId, patch }) => {
    if (patch.lastProjectId && !store.getProjects(workspaceId).some((project) => project.id === patch.lastProjectId)) throw new Error('Project not found')
    const preferences = store.setWorkspacePreferences(patch, workspaceId)
    broadcast('workspaces:preferences:changed', { workspaceId, preferences })
    return preferences
  })
  ipc.handle('workspaces:composer:import', (composer) => {
    const preferences = store.importLegacyComposerPreferences(composer)
    broadcast('workspaces:preferences:changed', { workspaceId: 'default', preferences })
    return preferences
  })
}
