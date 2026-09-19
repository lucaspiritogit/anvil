import type { WorkspaceSnapshot } from '@anvil/protocol/types'
import type { HandlerContext, HandlerRegistry } from '../handler-registry'
import type { Store } from '../store'
import { availableSettings } from './settings'

export function workspaceSnapshot(store: Store): WorkspaceSnapshot {
  const workspace = store.getActiveWorkspace()
  return {
    workspaces: store.getWorkspaces(), workspace,
    settings: availableSettings(store.getSettings(workspace.id)),
    preferences: store.getWorkspacePreferences(workspace.id),
    projects: store.getProjects(), tasks: store.getTasks(workspace.id),
    taskResultNotices: store.getTaskResultNotices(workspace.id)
  }
}

export function registerWorkspaceHandlers(
  ipc: HandlerRegistry,
  store: Store,
  broadcast: (channel: string, payload: unknown) => void,
  rename: (workspaceId: string, name: string) => ReturnType<Store['renameWorkspace']> | Promise<ReturnType<Store['renameWorkspace']>> = (workspaceId, name) => store.renameWorkspace(workspaceId, name),
  beforeSelect: () => Promise<void> = async () => {},
  afterSelect: (workspaceId: string, context: HandlerContext) => void = () => {},
  remove: (workspaceId: string) => ReturnType<Store['removeWorkspace']> | Promise<ReturnType<Store['removeWorkspace']>> = (workspaceId) => store.removeWorkspace(workspaceId)
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
  ipc.handle('workspaces:remove', async (workspaceId, context) => {
    const workspaces = store.getWorkspaces()
    if (!workspaces.some((workspace) => workspace.id === workspaceId)) throw new Error('Workspace not found')
    if (workspaces.length === 1) throw new Error('Anvil must have at least one workspace')
    if (store.hasRunningTasks(workspaceId)) throw new Error('Wait for running tasks in this workspace to finish before deleting it')
    const selecting = store.getActiveWorkspace().id === workspaceId
    if (selecting) await beforeSelect()
    await remove(workspaceId)
    const snapshot = workspaceSnapshot(store)
    broadcast('workspaces:changed', snapshot.workspaces)
    if (selecting) {
      afterSelect(snapshot.workspace.id, context)
      broadcast('workspaces:selected', snapshot)
    }
    return snapshot
  })
  ipc.handle('workspaces:select', async (workspaceId, context) => {
    if (!store.getWorkspaces().some((workspace) => workspace.id === workspaceId)) throw new Error('Workspace not found')
    await beforeSelect()
    store.selectWorkspace(workspaceId)
    afterSelect(workspaceId, context)
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
}
