import { randomUUID } from 'node:crypto'
import { and, cosineDistance, desc, eq, gt, sql } from 'drizzle-orm'
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import {
  EmbeddingProjectMemory,
  type EmbeddingOptions,
  type IndexedProjectMemory
} from './embedding-project-memory'
import type { ProjectMemoryMatch } from './project-memory'
import * as schema from './schema'

const { projectMemories } = schema

/** Project memory for self-hosted PostgreSQL and future managed deployments. */
export class PostgresProjectMemory extends EmbeddingProjectMemory {
  private readonly pool: Pool
  private readonly db: NodePgDatabase<typeof schema>

  constructor(databaseUrl: string, embeddingOptions: EmbeddingOptions) {
    super(embeddingOptions)
    this.pool = new Pool({ connectionString: databaseUrl, max: 4 })
    this.db = drizzle(this.pool, { schema })
  }

  async connect(): Promise<void> {
    const result = await this.db.execute<{ extension_installed: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'vector'
      ) AS extension_installed
    `)
    if (!result.rows[0]?.extension_installed) {
      throw new Error('The PostgreSQL vector extension is not installed')
    }
    try {
      await this.db.select({ id: projectMemories.id }).from(projectMemories).limit(1)
    } catch {
      throw new Error('The project_memories table is missing; apply the project-memory migrations')
    }
  }

  protected async upsert(memory: IndexedProjectMemory): Promise<void> {
    await this.db
      .insert(projectMemories)
      .values({ id: randomUUID(), kind: 'task_result', ...memory })
      .onConflictDoUpdate({
        target: [projectMemories.projectId, projectMemories.sourceRunId],
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
    const distance = cosineDistance(projectMemories.embedding, embedding)
    const similarity = sql<number>`1 - (${distance})`
    const rows = await this.db
      .select({ content: projectMemories.content, similarity })
      .from(projectMemories)
      .where(and(eq(projectMemories.projectId, projectId), gt(similarity, 0.5)))
      .orderBy(desc(similarity))
      .limit(limit)
    return rows.map((row) => ({ content: row.content, similarity: Number(row.similarity) }))
  }

  async forgetProject(projectId: string): Promise<void> {
    await this.db.delete(projectMemories).where(eq(projectMemories.projectId, projectId))
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
