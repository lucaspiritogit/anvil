import { join } from 'node:path'
import type { Settings, Task, TaskDiff, TaskEvent } from '../../shared/types'

export interface ProjectMemoryMatch {
  content: string
  similarity: number
}

export interface CompletedTaskMemory {
  task: Task
  diff?: TaskDiff
  events: TaskEvent[]
}

/** The storage and retrieval behavior available to task orchestration. */
export interface ProjectMemory {
  connect(): Promise<void>
  rememberCompletedTask(input: CompletedTaskMemory): Promise<void>
  recall(projectId: string, query: string, limit?: number): Promise<ProjectMemoryMatch[]>
  forgetProject(projectId: string): Promise<void>
  close(): Promise<void>
}

export interface ProjectMemoryOptions {
  workspaceId?: string
  dataDirectory: string
  migrationsFolder: string
  settings?: Pick<Settings, 'memoryEmbeddingModel' | 'ollamaBaseUrl'>
}

export type ProjectMemoryBackend = 'pglite' | 'postgres' | 'disabled'

/** Selects the local, self-hosted, or disabled adapter without exposing it to callers. */
export async function createProjectMemory(options: ProjectMemoryOptions): Promise<ProjectMemory | undefined> {
  const backend = (process.env.ANVIL_MEMORY_BACKEND ?? 'pglite') as ProjectMemoryBackend
  if (backend === 'disabled') return undefined

  const embeddingOptions = {
    baseUrl: options.settings?.ollamaBaseUrl ?? process.env.ANVIL_OLLAMA_BASE_URL,
    modelId: options.settings?.memoryEmbeddingModel ?? process.env.ANVIL_MEMORY_EMBEDDING_MODEL
  }
  if (backend === 'postgres') {
    const databaseUrl = process.env.ANVIL_MEMORY_DATABASE_URL
    if (!databaseUrl) {
      console.warn('PostgreSQL project memory requires ANVIL_MEMORY_DATABASE_URL.')
      return undefined
    }
    const { PostgresProjectMemory } = await import('./postgres-project-memory')
    return new PostgresProjectMemory(databaseUrl, embeddingOptions, options.workspaceId)
  }
  if (backend === 'pglite') {
    const { PgliteProjectMemory } = await import('./pglite-project-memory')
    return new PgliteProjectMemory(
      join(options.dataDirectory, 'pglite'),
      options.migrationsFolder,
      embeddingOptions
    )
  }

  console.warn(`Unknown project memory backend: ${backend}`)
  return undefined
}
