import type { Settings } from '../../shared/types'
import type { CompletedTaskMemory, ProjectMemory, ProjectMemoryMatch } from './project-memory'

type MemorySettings = Pick<Settings, 'memoryEnabled' | 'memoryEmbeddingModel' | 'ollamaBaseUrl'>

/** Lazily opens memory only when enabled; serializes adapter changes with active work. */
export class SettingsProjectMemory implements ProjectMemory {
  private adapter?: ProjectMemory
  private configuration = ''
  private queue: Promise<unknown> = Promise.resolve()
  private closed = false

  constructor(
    private readonly getSettings: () => MemorySettings,
    private readonly create: (settings: MemorySettings) => ProjectMemory | undefined
  ) {}

  isEnabled(): boolean {
    return !this.closed && this.getSettings().memoryEnabled
  }

  private key(settings = this.getSettings()): string {
    return JSON.stringify([settings.memoryEmbeddingModel, settings.ollamaBaseUrl])
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation)
    this.queue = next.catch(() => {})
    return next
  }

  private async release(): Promise<void> {
    const adapter = this.adapter
    this.adapter = undefined
    this.configuration = ''
    await adapter?.close()
  }

  /** Applying preferences never starts a database or embedding request. */
  settingsChanged(): void {
    void this.enqueue(async () => {
      if (!this.isEnabled() || this.configuration !== this.key()) await this.release()
    }).catch((error) => console.warn('Could not close project memory:', error))
  }

  private run<T>(fallback: T, operation: (adapter: ProjectMemory) => Promise<T>): Promise<T> {
    if (!this.isEnabled()) return Promise.resolve(fallback)
    return this.enqueue(async () => {
      if (!this.isEnabled()) return fallback
      const settings = this.getSettings()
      const configuration = this.key(settings)
      if (this.adapter && this.configuration !== configuration) await this.release()
      if (!this.adapter) {
        this.adapter = this.create(settings)
        this.configuration = configuration
        if (!this.adapter) return fallback
        try {
          await this.adapter.connect()
        } catch (error) {
          await this.release()
          throw error
        }
      }
      if (!this.isEnabled() || configuration !== this.key()) return fallback
      const result = await operation(this.adapter)
      // Never pass back context from an adapter disabled or replaced mid-request.
      return this.isEnabled() && configuration === this.key() ? result : fallback
    })
  }

  async connect(): Promise<void> {
    await this.run(undefined, async () => {})
  }

  recall(projectId: string, query: string, limit?: number): Promise<ProjectMemoryMatch[]> {
    return this.run([], (adapter) => adapter.recall(projectId, query, limit))
  }

  rememberCompletedTask(input: CompletedTaskMemory): Promise<void> {
    return this.run(undefined, (adapter) => adapter.rememberCompletedTask(input))
  }

  forgetProject(projectId: string): Promise<void> {
    return this.run(undefined, (adapter) => adapter.forgetProject(projectId))
  }

  close(): Promise<void> {
    this.closed = true
    return this.enqueue(() => this.release())
  }
}
