import type { Store } from '../store'
import type { Settings } from '../../shared/types'
import type { CompletedTaskMemory, ProjectMemory, ProjectMemoryMatch } from './project-memory'
import { SettingsProjectMemory } from './settings-project-memory'

/** Runtime callers capture an owner once; selection never retargets an adapter. */
export class WorkspaceProjectMemory implements ProjectMemory {
  private readonly adapters = new Map<string, SettingsProjectMemory>()

  constructor(
    private readonly store: Pick<Store, 'getSettings' | 'getActiveWorkspace' | 'getWorkspaces'>,
    private readonly create: (workspaceId: string, settings: Settings) => ProjectMemory | undefined | Promise<ProjectMemory | undefined>
  ) {}

  forWorkspace(workspaceId: string): ProjectMemory {
    let adapter = this.adapters.get(workspaceId)
    if (!adapter) {
      adapter = new SettingsProjectMemory(
        () => this.store.getSettings(workspaceId),
        () => this.create(workspaceId, this.store.getSettings(workspaceId))
      )
      this.adapters.set(workspaceId, adapter)
    }
    return adapter
  }

  settingsChanged(workspaceId: string): void {
    this.adapters.get(workspaceId)?.settingsChanged()
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    const adapter = this.adapters.get(workspaceId)
    this.adapters.delete(workspaceId)
    await adapter?.close()
  }

  async connect(): Promise<void> {}

  recall(projectId: string, query: string, limit?: number): Promise<ProjectMemoryMatch[]> {
    return this.forWorkspace(this.store.getActiveWorkspace().id).recall(projectId, query, limit)
  }

  rememberCompletedTask(input: CompletedTaskMemory): Promise<void> {
    return this.forWorkspace(input.task.workspaceId).rememberCompletedTask(input)
  }

  async forgetProject(projectId: string): Promise<void> {
    await this.forWorkspace(this.store.getActiveWorkspace().id).forgetProject(projectId)
  }

  async close(): Promise<void> {
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.close()))
    this.adapters.clear()
  }
}
