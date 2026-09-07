import Database from 'better-sqlite3'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as schema from './db/schema'
import { canSettleTask, settlementDeadline } from '../shared/task-settlement'
import { DEFAULT_KEYBINDINGS, normalizeKeybindings } from '../shared/keybindings'
import type { Project, Task, TaskComment, TaskEvent, Settings, TaskExecutionState } from '../shared/types'

const DEFAULT_SETTINGS: Settings = {
  defaultAgentId: 'opencode',
  defaultModel: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
  rebaseMode: 'manual',
  confirmRebase: true,
  keybindings: DEFAULT_KEYBINDINGS
}

/** The settings table stores text, so non-string values are encoded here. */
const SETTING_KEYS = [
  'defaultAgentId',
  'defaultModel',
  'rebaseMode',
  'confirmRebase',
  'keybindings'
] as const

function encodeSetting(key: keyof Settings, value: Settings[keyof Settings]): string {
  if (key === 'confirmRebase') return String(value === true)
  if (key === 'keybindings') return JSON.stringify(value)
  return String(value)
}

function decodeKeybindings(value: string): Settings['keybindings'] {
  try {
    return normalizeKeybindings(JSON.parse(value))
  } catch {
    return DEFAULT_KEYBINDINGS
  }
}

const { projects, taskComments, taskEvents, tasks, settings } = schema

type ProjectRow = typeof projects.$inferSelect
type TaskRow = typeof tasks.$inferSelect
type TaskCommentRow = typeof taskComments.$inferSelect
type TaskEventRow = typeof taskEvents.$inferSelect

/**
 * Rows already arrive with the schema's field names, so mapping to the shared
 * types is only about the optional-versus-null difference: SQLite stores
 * absence as null, while the renderer's types omit the key.
 */
function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: row.createdAt,
    monthlyTokenLimit: row.monthlyTokenLimit,
    monthlyCostLimitUsd: row.monthlyCostLimitUsd,
    finishOnPush: row.finishOnPush,
    gitPlatform: row.gitPlatform
  }
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    agentLabel: row.agentLabel,
    ...(row.model === null ? {} : { model: row.model }),
    prompt: row.prompt,
    title: row.title,
    cwd: row.cwd,
    status: row.status,
    startedAt: row.startedAt,
    ...(row.endedAt === null ? {} : { endedAt: row.endedAt }),
    ...(row.reviewedAt === null ? {} : { reviewedAt: row.reviewedAt }),
    ...(row.settledAt === null ? {} : { settledAt: row.settledAt }),
    exitCode: row.exitCode,
    ...(row.error === null ? {} : { error: row.error }),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedTokens: row.cachedTokens,
    totalTokens: row.totalTokens,
    costUsd: row.costUsd,
    deliveryStatus: row.deliveryStatus,
    ...(row.baseBranch === null ? {} : { baseBranch: row.baseBranch }),
    ...(row.branchName === null ? {} : { branchName: row.branchName }),
    ...(row.baseCommit === null ? {} : { baseCommit: row.baseCommit }),
    ...(row.headCommit === null ? {} : { headCommit: row.headCommit }),
    ...(row.worktreePath === null ? {} : { worktreePath: row.worktreePath }),
    filesChanged: row.filesChanged,
    additions: row.additions,
    deletions: row.deletions,
    ...(row.deliveryError === null ? {} : { deliveryError: row.deliveryError }),
    ...(row.sessionId === null ? {} : { sessionId: row.sessionId })
  }
}

function toTaskComment(row: TaskCommentRow): TaskComment {
  return {
    id: row.id,
    taskId: row.taskId,
    file: row.file,
    side: row.side,
    lineNumber: row.lineNumber,
    body: row.body,
    createdAt: row.createdAt,
    sentAt: row.sentAt
  }
}

function toTaskEvent(row: TaskEventRow): TaskEvent {
  return {
    id: row.id,
    taskId: row.taskId,
    ts: row.ts,
    stream: row.stream,
    kind: row.kind,
    category: row.category,
    text: row.text
  }
}

/** The row a `Task` writes, with its optional fields collapsed back to null. */
function toTaskRow(task: Task): typeof tasks.$inferInsert {
  return {
    ...task,
    model: task.model ?? null,
    endedAt: task.endedAt ?? null,
    reviewedAt: task.reviewedAt ?? null,
    settledAt: task.settledAt ?? null,
    exitCode: task.exitCode ?? null,
    error: task.error ?? null,
    baseBranch: task.baseBranch ?? null,
    branchName: task.branchName ?? null,
    baseCommit: task.baseCommit ?? null,
    headCommit: task.headCommit ?? null,
    worktreePath: task.worktreePath ?? null,
    deliveryError: task.deliveryError ?? null,
    sessionId: task.sessionId ?? null
  }
}

export interface StoreOptions {
  /**
   * Where the generated migrations live. The caller resolves it because the
   * folder sits beside the source in development and inside the app bundle in
   * a packaged build.
   */
  migrationsFolder: string
}

export class Store {
  private readonly sqlite: Database.Database
  private readonly db: BetterSQLite3Database<typeof schema>

  constructor(databaseFile: string, options: StoreOptions) {
    mkdirSync(dirname(databaseFile), { recursive: true })
    this.sqlite = new Database(databaseFile)
    this.sqlite.pragma('journal_mode = WAL')
    this.sqlite.pragma('synchronous = NORMAL')
    this.sqlite.pragma('foreign_keys = ON')
    this.db = drizzle(this.sqlite, { schema })
    migrate(this.db, { migrationsFolder: options.migrationsFolder })

    this.seedSettings()
    this.markInterruptedTasksFailed()
    // Restart stops Anvil execution, not other clients sharing Valence storage.
    for (const row of this.db.select().from(schema.taskExecutions).all()) {
      if (row.state.phase === 'planning' || row.state.phase === 'working' || row.state.phase === 'recovering') {
        this.saveTaskExecution({ ...row.state, phase: 'blocked', error: 'Interrupted by app restart. Inspect Valence work before requeueing.' })
      }
    }
  }

  private seedSettings(): void {
    this.db
      .insert(settings)
      .values(
        SETTING_KEYS.map((key) => ({ key, value: encodeSetting(key, DEFAULT_SETTINGS[key]) }))
      )
      .onConflictDoNothing()
      .run()
  }

  /** A task cannot outlive the app, so anything still 'running' died with it. */
  private markInterruptedTasksFailed(): void {
    this.db
      .update(tasks)
      .set({
        status: 'failed',
        deliveryStatus: 'agent_failed',
        error: 'Interrupted by app restart',
        deliveryError: 'The agent was interrupted before Git delivery completed.',
        endedAt: sql`COALESCE(${tasks.endedAt}, ${Date.now()})`
      })
      .where(eq(tasks.status, 'running'))
      .run()
  }

  getSettings(): Settings {
    return this.db
      .select()
      .from(settings)
      .all()
      .reduce<Settings>(
        (current, row) => {
          if (row.key === 'confirmRebase') current.confirmRebase = row.value === 'true'
          else if (row.key === 'keybindings') current.keybindings = decodeKeybindings(row.value)
          else if (row.key === 'rebaseMode') {
            current.rebaseMode = row.value === 'agent' ? 'agent' : 'manual'
          } else if (row.key === 'defaultAgentId' || row.key === 'defaultModel') {
            current[row.key] = row.value
          }
          return current
        },
        { ...DEFAULT_SETTINGS }
      )
  }

  setSettings(next: Partial<Settings>): Settings {
    const rows = SETTING_KEYS.filter((key) => next[key] !== undefined).map((key) => ({
      key,
      value: encodeSetting(key, next[key]!)
    }))
    if (rows.length) {
      this.db.transaction((tx) => {
        for (const row of rows) {
          tx.insert(settings)
            .values(row)
            .onConflictDoUpdate({ target: settings.key, set: { value: row.value } })
            .run()
        }
      })
    }
    return this.getSettings()
  }

  getProjects(): Project[] {
    return this.db.select().from(projects).orderBy(asc(projects.createdAt)).all().map(toProject)
  }

  addProject(project: Project): Project {
    this.db.insert(projects).values(project).onConflictDoNothing().run()
    // The insert is a no-op when the path is already tracked, so the stored row
    // is the answer either way.
    const row = this.db.select().from(projects).where(eq(projects.path, project.path)).get()!
    return toProject(row)
  }

  removeProject(id: string): void {
    this.db.delete(projects).where(eq(projects.id, id)).run()
  }

  updateProject(
    id: string,
    patch: Pick<Project, 'monthlyTokenLimit' | 'monthlyCostLimitUsd' | 'finishOnPush'>
  ): Project | undefined {
    this.db.update(projects).set(patch).where(eq(projects.id, id)).run()
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get()
    return row ? toProject(row) : undefined
  }

  getTasks(): Task[] {
    return this.db.select().from(tasks).orderBy(desc(tasks.startedAt)).all().map(toTask)
  }

  addTask(task: Task): Task {
    this.db.insert(tasks).values(toTaskRow(task)).run()
    return task
  }

  /** Foreign keys cascade to execution metadata, output, and comments, not Valence issues. */
  deleteTaskCascade(taskId: string): void {
    this.db.delete(tasks).where(eq(tasks.id, taskId)).run()
  }

  updateTask(id: string, patch: Partial<Task>): Task | undefined {
    const current = this.getTask(id)
    if (!current) return undefined
    const next = {
      ...current, ...patch,
      ...(patch.status === 'running' ? { reviewedAt: undefined, settledAt: undefined } : {})
    }
    this.db.update(tasks).set(toTaskRow(next)).where(eq(tasks.id, id)).run()
    return next
  }

  settleTask(id: string, now = Date.now()): Task {
    const task = this.getTask(id)
    if (!task) throw new Error('Task not found')
    if (task.settledAt !== undefined) return task
    if (!canSettleTask(task)) throw new Error('Only successful, reviewed tasks can be settled')
    return this.updateTask(id, { settledAt: now })!
  }

  /** Also called on list/load, so time spent with the app closed counts toward the TTL. */
  settleDueTasks(now = Date.now()): Task[] {
    return this.db.transaction(() => this.getTasks().flatMap((task) => {
      const deadline = settlementDeadline(task)
      return deadline !== undefined && deadline <= now ? [this.settleTask(task.id, deadline)] : []
    }))
  }

  getTask(id: string): Task | undefined {
    const row = this.db.select().from(tasks).where(eq(tasks.id, id)).get()
    return row ? { ...toTask(row), } : undefined
  }

  /** Every note on a task, drafts and sent alike, oldest first. */
  getComments(taskId: string): TaskComment[] {
    return this.db
      .select()
      .from(taskComments)
      .where(eq(taskComments.taskId, taskId))
      .orderBy(asc(taskComments.createdAt))
      .all()
      .map(toTaskComment)
  }

  addComment(comment: TaskComment): TaskComment {
    this.db.insert(taskComments).values(comment).run()
    return comment
  }

  removeComment(id: string): void {
    this.db.delete(taskComments).where(eq(taskComments.id, id)).run()
  }

  /** Marks a task's drafts as sent; returns the comments that were pending. */
  markCommentsSent(taskId: string, sentAt: number): TaskComment[] {
    const pending = this.getComments(taskId).filter((comment) => comment.sentAt === null)
    if (!pending.length) return []
    this.db
      .update(taskComments)
      .set({ sentAt })
      .where(
        and(
          eq(taskComments.taskId, taskId),
          isNull(taskComments.sentAt),
          inArray(
            taskComments.id,
            pending.map((comment) => comment.id)
          )
        )
      )
      .run()
    return pending.map((comment) => ({ ...comment, sentAt }))
  }

  appendEvent(event: TaskEvent): void {
    // Tool snapshots replace their prior row without changing insertion order.
    this.db.insert(taskEvents).values(event).onConflictDoUpdate({
      target: taskEvents.id,
      set: { text: event.text, category: event.category, stream: event.stream }
    }).run()
  }

  readEvents(taskId: string): TaskEvent[] {
    return this.db
      .select()
      .from(taskEvents)
      .where(eq(taskEvents.taskId, taskId))
      .orderBy(asc(taskEvents.sequence))
      .all()
      .map(toTaskEvent)
  }

  close(): void {
    this.sqlite.close()
  }

  getTaskExecution(taskId: string): TaskExecutionState | undefined {
    return this.db.select().from(schema.taskExecutions).where(eq(schema.taskExecutions.taskId, taskId)).get()?.state
  }

  saveTaskExecution(state: TaskExecutionState): TaskExecutionState {
    this.db.insert(schema.taskExecutions).values({ taskId: state.taskId, state })
      .onConflictDoUpdate({ target: schema.taskExecutions.taskId, set: { state } }).run()
    return state
  }

}
