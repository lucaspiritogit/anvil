import { createHash } from 'node:crypto'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { embed, type EmbeddingModel } from 'ai'
import type { ProjectMemoryMetadata } from './schema'
import type {
  CompletedRunMemory,
  ProjectMemory,
  ProjectMemoryMatch
} from './project-memory'

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434/v1'
const DEFAULT_EMBEDDING_MODEL = 'mxbai-embed-large'
const EMBEDDING_DIMENSIONS = 1024
const MAX_EMBEDDING_INPUT_CHARACTERS = 1_800
const MAX_AGENT_SUMMARY_CHARACTERS = 2_000
const MAX_PATCH_CHARACTERS = 4_000

export interface EmbeddingOptions {
  baseUrl?: string
  modelId?: string
}

export interface IndexedProjectMemory {
  projectId: string
  sourceRunId: string
  content: string
  contentHash: string
  metadata: ProjectMemoryMetadata
  embedding: number[]
}

/** Shares memory extraction and embedding behavior across persistence adapters. */
export abstract class EmbeddingProjectMemory implements ProjectMemory {
  private readonly embeddingModel: EmbeddingModel

  protected constructor(options: EmbeddingOptions) {
    const ollama = createOpenAICompatible({
      name: 'ollama',
      baseURL: options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
      apiKey: 'ollama'
    })
    this.embeddingModel = ollama.embeddingModel(options.modelId ?? DEFAULT_EMBEDDING_MODEL)
  }

  abstract connect(): Promise<void>
  abstract forgetProject(projectId: string): Promise<void>
  abstract close(): Promise<void>

  protected abstract upsert(memory: IndexedProjectMemory): Promise<void>
  protected abstract findSimilar(
    projectId: string,
    embedding: number[],
    limit: number
  ): Promise<ProjectMemoryMatch[]>

  async rememberCompletedRun(input: CompletedRunMemory): Promise<void> {
    const content = memoryDocument(input)
    const embedding = await this.embed(content)
    const metadata: ProjectMemoryMetadata = {
      title: input.run.title,
      status: input.run.status,
      deliveryStatus: input.run.deliveryStatus,
      branchName: input.run.branchName ?? null,
      headCommit: input.run.headCommit ?? null,
      filesChanged: input.run.filesChanged,
      additions: input.run.additions,
      deletions: input.run.deletions
    }
    await this.upsert({
      projectId: input.run.projectId,
      sourceRunId: input.run.id,
      content,
      contentHash: createHash('sha256').update(content).digest('hex'),
      metadata,
      embedding
    })
  }

  async recall(projectId: string, query: string, limit = 5): Promise<ProjectMemoryMatch[]> {
    const embedding = await this.embed(query)
    return this.findSimilar(projectId, embedding, Math.max(1, Math.min(limit, 20)))
  }

  private async embed(value: string): Promise<number[]> {
    const { embedding } = await embed({
      model: this.embeddingModel,
      value: value.slice(0, MAX_EMBEDDING_INPUT_CHARACTERS)
    })
    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Embedding model returned ${embedding.length} dimensions; project memory expects ${EMBEDDING_DIMENSIONS}`
      )
    }
    return embedding
  }
}

function memoryDocument({ run, diff, events }: CompletedRunMemory): string {
  const agentSummary = events
    .filter((event) => event.category === 'message' && event.text.trim())
    .map((event) => event.text.trim())
    .join('\n')
    .slice(-MAX_AGENT_SUMMARY_CHARACTERS)
  const commits = diff?.commits.map((commit) => `- ${commit.subject}`).join('\n')
  const patch = diff?.patch.slice(0, MAX_PATCH_CHARACTERS)

  return [
    `Task: ${run.prompt.trim()}`,
    `Outcome: ${run.status}; delivery ${run.deliveryStatus}; ${run.filesChanged} files changed, +${run.additions}/-${run.deletions}.`,
    commits ? `Commits:\n${commits}` : undefined,
    agentSummary ? `Agent result:\n${agentSummary}` : undefined,
    patch ? `Code changes:\n${patch}` : undefined
  ]
    .filter((section): section is string => Boolean(section))
    .join('\n\n')
}
