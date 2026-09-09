import { sql } from 'drizzle-orm'
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector
} from 'drizzle-orm/pg-core'

export interface ProjectMemoryMetadata {
  embeddingModel?: string
  title: string
  status: string
  deliveryStatus: string
  branchName: string | null
  headCommit: string | null
  filesChanged: number
  additions: number
  deletions: number
}

export const projectMemories = pgTable(
  'project_memories',
  {
    id: uuid('id').primaryKey(),
    projectId: text('project_id').notNull(),
    sourceTaskId: text('source_task_id').notNull(),
    kind: text('kind').$type<'task_result'>().notNull(),
    content: text('content').notNull(),
    contentHash: text('content_hash').notNull(),
    metadata: jsonb('metadata').$type<ProjectMemoryMetadata>().notNull().default({} as ProjectMemoryMetadata),
    embedding: vector('embedding', { dimensions: 1024 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex('project_memories_project_task_idx').on(table.projectId, table.sourceTaskId),
    index('project_memories_project_idx').on(table.projectId, table.updatedAt.desc()),
    index('project_memories_embedding_hnsw_idx').using(
      'hnsw',
      table.embedding.op('vector_cosine_ops')
    ),
    check('project_memories_kind_valid', sql`${table.kind} IN ('task_result')`)
  ]
)
