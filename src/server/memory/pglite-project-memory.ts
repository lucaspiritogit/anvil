import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { vector } from '@electric-sql/pglite-pgvector'
import { and, cosineDistance, desc, eq, gt, sql } from 'drizzle-orm'
import { drizzle, type PgliteDatabase } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import {
  EmbeddingProjectMemory,
  type EmbeddingOptions,
  type IndexedProjectMemory
} from './embedding-project-memory'
import type { ProjectMemoryMatch } from './project-memory'
import * as schema from './schema'

const { projectMemories } = schema

/** Embedded, filesystem-backed project memory for the desktop client. */
export class PgliteProjectMemory extends EmbeddingProjectMemory {
  private client?: PGlite
  private database?: PgliteDatabase<typeof schema>
  private readonly ready: Promise<void>

  constructor(dataDirectory: string, migrationsFolder: string, embeddingOptions: EmbeddingOptions) {
    super(embeddingOptions)
    this.ready = this.initialize(dataDirectory, migrationsFolder)
  }

  private async initialize(dataDirectory: string, migrationsFolder: string): Promise<void> {
    await mkdir(dataDirectory, { recursive: true })
    this.client = await PGlite.create(dataDirectory, { extensions: { vector } })
    // pgvector is a database prerequisite, not part of Drizzle's table models.
    await this.client.exec('CREATE EXTENSION IF NOT EXISTS vector')
    this.database = drizzle(this.client, { schema })
    await migrate(this.database, { migrationsFolder })
  }

  async connect(): Promise<void> {
    await this.ready
  }

  protected async upsert(memory: IndexedProjectMemory): Promise<void> {
    const database = await this.getDatabase()
    await database
      .insert(projectMemories)
      .values({ id: randomUUID(), kind: 'task_result', ...memory })
      .onConflictDoUpdate({
        target: [projectMemories.projectId, projectMemories.sourceTaskId],
        set: {
          content: memory.content,
          contentHash: memory.contentHash,
          metadata: memory.metadata,
          embedding: memory.embedding,
          updatedAt: new Date()
        }
      })
  }

  protected async findSimilar(
    projectId: string,
    embedding: number[],
    limit: number
  ): Promise<ProjectMemoryMatch[]> {
    const database = await this.getDatabase()
    const distance = cosineDistance(projectMemories.embedding, embedding)
    const similarity = sql<number>`1 - (${distance})`
    const rows = await database
      .select({ content: projectMemories.content, similarity })
      .from(projectMemories)
      .where(and(
        eq(projectMemories.projectId, projectId),
        sql`${projectMemories.metadata}->>'embeddingModel' = ${this.embeddingModelId}`,
        gt(similarity, 0.5)
      ))
      .orderBy(desc(similarity))
      .limit(limit)
    return rows.map((row) => ({ content: row.content, similarity: Number(row.similarity) }))
  }

  async forgetProject(projectId: string): Promise<void> {
    const database = await this.getDatabase()
    await database.delete(projectMemories).where(eq(projectMemories.projectId, projectId))
  }

  async close(): Promise<void> {
    try {
      await this.ready
    } catch {
      // Initialization failures are reported by connect(); shutdown remains safe.
    }
    await this.client?.close()
  }

  private async getDatabase(): Promise<PgliteDatabase<typeof schema>> {
    await this.ready
    if (!this.database) throw new Error('PGlite project memory did not initialize')
    return this.database
  }
}
