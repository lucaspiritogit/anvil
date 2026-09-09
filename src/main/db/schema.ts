/**
 * Anvil's database schema, declared once.
 *
 * `drizzle-kit generate` diffs this against the stored snapshot and writes a
 * numbered migration into `src/main/db/migrations`; the app applies whatever is
 * outstanding when it opens the database. Nothing here is hand-written DDL, and
 * no migration is hand-written either — change a table below and run
 * `npm run db:generate`.
 */
import { sql, type SQL } from 'drizzle-orm'
import type { Issue } from '../../shared/valence'
import { check, index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import type {
  DeliveryStatus,
  TaskComment,
  TaskEventCategory,
  TaskEventKind,
  TaskStatus,
  StreamName,
  TaskExecutionState
} from '../../shared/types'

/**
 * Renders a TypeScript union as a SQL `IN (...)` list for a CHECK constraint.
 * The values are inlined with `sql.raw` rather than interpolated: interpolation
 * produces bound parameters, and a constraint cannot carry `?` placeholders.
 */
function oneOf(column: SQLiteColumn, values: readonly string[]): SQL {
  const literals = values.map((value) => `'${value.replaceAll("'", "''")}'`).join(', ')
  return sql`${column} IN (${sql.raw(literals)})`
}

const TASK_STATUSES: TaskStatus[] = ['pending', 'running', 'succeeded', 'failed', 'cancelled']
const DELIVERY_STATUSES: DeliveryStatus[] = [
  'preparing',
  'working',
  'finalizing',
  'did_not_commit',
  'reviewable',
  'approved',
  'no_changes',
  'agent_failed',
  'failed',
  'unavailable'
]
const STREAMS: StreamName[] = ['stdout', 'stderr', 'system']
const EVENT_KINDS: TaskEventKind[] = ['output', 'did_not_commit', 'delivery']
const EVENT_CATEGORIES: TaskEventCategory[] = [
  'message',
  'thinking',
  'tool_use',
  'tool_result',
  'system',
  'error'
]
const COMMENT_SIDES: TaskComment['side'][] = ['additions', 'deletions']

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    path: text('path').notNull().unique(),
    createdAt: integer('created_at').notNull(),
    monthlyTokenLimit: integer('monthly_token_limit'),
    monthlyCostLimitUsd: real('monthly_cost_limit_usd'),
    // SQLite has no boolean; `mode: 'boolean'` maps 0/1 to a JS boolean, which
    // also stops booleans reaching the driver, which cannot bind them.
    finishOnPush: integer('finish_on_push', { mode: 'boolean' }).notNull().default(false),
    gitPlatform: text('git_platform').$type<'github'>().notNull().default('github')
  },
  (table) => [
    check('projects_finish_on_push_bool', sql`${table.finishOnPush} IN (0, 1)`),
    check('projects_git_platform_valid', oneOf(table.gitPlatform, ['github']))
  ]
)

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    agentLabel: text('agent_label').notNull(),
    model: text('model'),
    prompt: text('prompt').notNull(),
    title: text('title').notNull(),
    cwd: text('cwd').notNull(),
    status: text('status').$type<TaskStatus>().notNull(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    reviewedAt: integer('reviewed_at'),
    settledAt: integer('settled_at'),
    exitCode: integer('exit_code'),
    error: text('error'),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cachedTokens: integer('cached_tokens').notNull().default(0),
    totalTokens: integer('total_tokens').notNull().default(0),
    costUsd: real('cost_usd'),
    deliveryStatus: text('delivery_status')
      .$type<DeliveryStatus>()
      .notNull()
      .default('unavailable'),
    baseBranch: text('base_branch'),
    branchName: text('branch_name'),
    baseCommit: text('base_commit'),
    headCommit: text('head_commit'),
    filesChanged: integer('files_changed').notNull().default(0),
    additions: integer('additions').notNull().default(0),
    deletions: integer('deletions').notNull().default(0),
    deliveryError: text('delivery_error'),
    sessionId: text('session_id')
  },
  (table) => [
    // Plain columns, not `sql`…DESC`` — drizzle-kit re-emits a raw index
    // expression as a quoted identifier when it rebuilds the table, producing a
    // migration that cannot run. SQLite reads an index in either direction, so
    // this still serves `ORDER BY started_at DESC`.
    index('tasks_project_started_idx').on(table.projectId, table.startedAt),
    check('tasks_status_valid', oneOf(table.status, TASK_STATUSES)),
    check('tasks_delivery_status_valid', oneOf(table.deliveryStatus, DELIVERY_STATUSES))
  ]
)

export const taskComments = sqliteTable(
  'task_comments',
  {
    id: text('id').primaryKey(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    file: text('file').notNull(),
    side: text('side').$type<TaskComment['side']>().notNull(),
    lineNumber: integer('line_number').notNull(),
    body: text('body').notNull(),
    createdAt: integer('created_at').notNull(),
    sentAt: integer('sent_at')
  },
  (table) => [
    index('task_comments_task_idx').on(table.taskId, table.createdAt),
    check('task_comments_side_valid', oneOf(table.side, COMMENT_SIDES))
  ]
)

export const taskEvents = sqliteTable(
  'task_events',
  {
    // Insertion order is how the log is read back, so the ordering key is the
    // primary key rather than the event's own id.
    sequence: integer('sequence').primaryKey({ autoIncrement: true }),
    id: text('id').notNull().unique(),
    taskId: text('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    issueId: text('issue_id'),
    ts: integer('ts').notNull(),
    stream: text('stream').$type<StreamName>().notNull(),
    kind: text('kind').$type<TaskEventKind>().notNull().default('output'),
    category: text('category').$type<TaskEventCategory>().notNull().default('message'),
    text: text('text').notNull()
  },
  (table) => [
    index('task_events_task_sequence_idx').on(table.taskId, table.sequence),
    check('task_events_stream_valid', oneOf(table.stream, STREAMS)),
    check('task_events_kind_valid', oneOf(table.kind, EVENT_KINDS)),
    check('task_events_category_valid', oneOf(table.category, EVENT_CATEGORIES))
  ]
)

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull()
})

export const taskExecutions = sqliteTable('task_executions', {
  taskId: text('task_id').primaryKey().references(() => tasks.id, { onDelete: 'cascade' }),
  state: text('state', { mode: 'json' }).$type<TaskExecutionState>().notNull()
})

export const taskPullRequests = sqliteTable('task_pull_requests', {
  taskId: text('task_id').primaryKey().references(() => tasks.id, { onDelete: 'cascade' }),
  repository: text('repository').notNull(),
  number: integer('number').notNull(),
  headSha: text('head_sha').notNull(),
  sourceBranch: text('source_branch').notNull(),
  targetBranch: text('target_branch').notNull()
})

// Valence ownership is parent -> task -> project. Do not duplicate project_id.
// Sequence keys replace Valence's implicit rowid ordering and are never reused.
export const parentIssues = sqliteTable('parent_issues', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  anvilTaskId: text('anvil_task_id').notNull().unique()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description').notNull()
})

export const issues = sqliteTable('issues', {
  sequence: integer('sequence').primaryKey({ autoIncrement: true }),
  id: text('id').notNull().unique(),
  parentId: text('parent_id').notNull().references(() => parentIssues.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description').notNull(),
  checklist: text('checklist', { mode: 'json' }).$type<string[]>().notNull(),
  validation: text('validation').notNull(),
  labels: text('labels', { mode: 'json' }).$type<string[]>().notNull(),
  priority: text('priority').$type<Issue['priority']>().notNull(),
  status: text('status').$type<Issue['status']>().notNull(),
  evidence: text('evidence'),
  completedAt: integer('completed_at'),
  reviewedAt: integer('reviewed_at')
}, (table) => [
  index('issues_parent_sequence_idx').on(table.parentId, table.sequence),
  check('issues_priority_valid', oneOf(table.priority, ['urgent', 'high', 'medium', 'low'])),
  check('issues_status_valid', oneOf(table.status, ['queued', 'working', 'blocked', 'review', 'complete']))
])

// The Issue.dependencies array is read from these rows ORDER BY position.
// Cross-parent dependencies remain supported. Deleting either endpoint removes
// the link, including when a task/project deletion cascades through its issues.
// Runtime graph validation must still reject cycles before writing a batch.
export const issueDependencies = sqliteTable('issue_dependencies', {
  issueId: text('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  dependencyId: text('dependency_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  position: integer('position').notNull()
}, (table) => [
  primaryKey({ columns: [table.issueId, table.dependencyId] }),
  uniqueIndex('issue_dependencies_position_idx').on(table.issueId, table.position),
  index('issue_dependencies_target_idx').on(table.dependencyId),
  check('issue_dependencies_position_valid', sql`${table.position} >= 0`),
  check('issue_dependencies_not_self', sql`${table.issueId} <> ${table.dependencyId}`)
])

// Historical import receipts retained for schema compatibility. Runtime tracker
// access uses only Anvil's embedded plans and never reads or writes these receipts.
export const valenceImports = sqliteTable('valence_imports', {
  sourcePath: text('source_path').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  fingerprint: text('fingerprint').notNull(),
  parents: text('parents', { mode: 'json' }).$type<Record<string, string>>().notNull(),
  importedAt: integer('imported_at').notNull()
})
