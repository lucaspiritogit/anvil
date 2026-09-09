import { IssueTracker } from './valence/tracker'
import Database from 'better-sqlite3'
import { TaskImageStorage } from './task-image-storage'
import type { PullRequestMerged } from '../shared/github-pull-request-state'
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as schema from './db/schema'
import { canSettleTask, settlementDeadline } from '../shared/task-settlement'
import { DEFAULT_KEYBINDINGS, normalizeKeybindings } from '../shared/keybindings'
import type { Project, Task, TaskComment, TaskEvent, Settings, TaskExecutionState } from '../shared/types'
import { DEFAULT_FONT_SIZE, normalizeFontSize, DEFAULT_OVERVIEW_COLOR, OVERVIEW_COLOR_PATTERN, isWallpaperId } from '../shared/appearance'
import { DEFAULT_OLLAMA_BASE_URL, DEFAULT_EMBEDDING_MODEL, isOllamaBaseUrl } from '../shared/memory-settings'

const DEFAULT_SETTINGS: Settings = {
  memoryEnabled: false,
  memoryEmbeddingModel: DEFAULT_EMBEDDING_MODEL,
  ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
  fontSize: DEFAULT_FONT_SIZE,
  overviewBackgroundMode: 'color',
  overviewBackgroundColor: DEFAULT_OVERVIEW_COLOR,
  overviewWallpaperId: null,
  defaultAgentId: 'opencode',
  defaultModel: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
  rebaseMode: 'manual',
  confirmRebase: true,
  caffeineMode: false,
  keybindings: DEFAULT_KEYBINDINGS
}

/** The settings table stores text, so non-string values are encoded here. */
const SETTING_KEYS = [
  'memoryEnabled',
  'memoryEmbeddingModel',
  'ollamaBaseUrl',
  'fontSize',
  'defaultAgentId',
  'defaultModel',
  'rebaseMode',
  'confirmRebase',
  'caffeineMode',
  'keybindings',
  'overviewBackgroundMode',
  'overviewBackgroundColor',
  'overviewWallpaperId'
] as const

function encodeSetting(key: keyof Settings, value: Settings[keyof Settings]): string {
  if (key === 'confirmRebase' || key === 'caffeineMode' || key === 'memoryEnabled') return String(value === true)
  if (key === 'keybindings') return JSON.stringify(value)
  if (key === 'overviewWallpaperId') return isWallpaperId(value) ? value : ''
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
    issueId: row.issueId ?? undefined,
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
  private readonly activityListeners = new Set<() => void>()

  /** Observe task membership/status and the setting that controls keeping tasks awake. */
  subscribeActivity(listener: () => void): () => void {
    this.activityListeners.add(listener)
    return () => { this.activityListeners.delete(listener) }
  }

  private activityChanged(): void {
    for (const listener of this.activityListeners) listener()
  }

  hasRunningTasks(): boolean {
    return this.db.select({ id: tasks.id }).from(tasks).where(eq(tasks.status, 'running')).limit(1).get() !== undefined
  }

  readonly taskImages: TaskImageStorage

  constructor(databaseFile: string, options: StoreOptions) {
    this.taskImages = new TaskImageStorage(`${databaseFile}.images`)
    mkdirSync(dirname(databaseFile), { recursive: true })
    this.sqlite = new Database(databaseFile)
    this.sqlite.pragma('journal_mode = WAL')
    this.sqlite.pragma('synchronous = NORMAL')
    this.db = drizzle(this.sqlite, { schema })
    // SQLite table rebuilds must disable foreign keys outside the migration
    // transaction, or dropping tasks cascades into its events and execution state.
    this.sqlite.pragma('foreign_keys = OFF')
    try {
      migrate(this.db, { migrationsFolder: options.migrationsFolder })
    } finally {
      this.sqlite.pragma('foreign_keys = ON')
    }

    this.seedSettings()
    this.recoverInterruptedTasks()
    this.taskImages.prune(new Set(this.getTasks().filter((task) => task.status !== 'cancelled' && task.deliveryStatus !== 'failed').map((task) => task.id)))
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
  private recoverInterruptedTasks(): void {
    for (const task of this.getTasks()) {
      const unfinishedDelivery = ['preparing', 'working', 'finalizing', 'did_not_commit'].includes(task.deliveryStatus)
      if (task.status !== 'running' && !unfinishedDelivery) continue
      // Old versions used cancellation for shutdown too. An unfinished delivery
      // without an explicit Stop event is recoverable after restart.
      const stoppedByUser = task.status === 'cancelled' && this.readEvents(task.id).some((event) => event.text === 'Stop requested by user.')
      this.updateTask(task.id, {
        status: stoppedByUser ? 'cancelled' : 'pending',
        deliveryStatus: task.deliveryStatus === 'unavailable' ? 'unavailable' : 'agent_failed',
        error: stoppedByUser ? task.error : 'Interrupted by app restart',
        deliveryError: 'The agent was interrupted before Git delivery completed.',
        endedAt: task.endedAt ?? Date.now()
      })
    }
  }

  linkPullRequest(taskId: string, link: Omit<PullRequestMerged, 'mergedAt'>): void {
    this.db.insert(schema.taskPullRequests).values({ ...link, taskId, repository: link.repository.toLowerCase() })
      .onConflictDoUpdate({ target: schema.taskPullRequests.taskId, set: { ...link, repository: link.repository.toLowerCase() } }).run()
  }

  getPullRequestsToRefresh(): (Omit<PullRequestMerged, 'mergedAt'> & { taskId: string })[] {
    return this.db.select().from(schema.taskPullRequests).all().filter((link) => {
      const task = this.getTask(link.taskId)
      return task?.status === 'succeeded' && task.deliveryStatus === 'reviewable' && task.headCommit === link.headSha
    })
  }

  approveMergedPullRequest(event: PullRequestMerged): Task[] {
    return this.db.transaction(() => {
      const links = this.db.select().from(schema.taskPullRequests).where(and(
        eq(schema.taskPullRequests.repository, event.repository.toLowerCase()),
        eq(schema.taskPullRequests.number, event.number)
      )).all()
      const updated: Task[] = []
      for (const link of links) {
        const task = this.getTask(link.taskId)
        if (!task || task.status !== 'succeeded' || task.deliveryStatus !== 'reviewable' ||
          task.headCommit !== link.headSha || event.headSha !== link.headSha ||
          event.sourceBranch !== link.sourceBranch || event.targetBranch !== link.targetBranch) continue
        const approved = this.updateTask(task.id, { deliveryStatus: 'approved', reviewedAt: Date.now() })
        if (approved) updated.push(approved)
      }
      return updated
    })
  }

  getSettings(): Settings {
    return this.db
      .select()
      .from(settings)
      .all()
      .reduce<Settings>(
        (current, row) => {
          if (row.key === 'confirmRebase' || row.key === 'caffeineMode' || row.key === 'memoryEnabled') current[row.key] = row.value === 'true'
          else if (row.key === 'overviewBackgroundMode') current.overviewBackgroundMode = row.value === 'image' ? 'image' : 'color'
          else if (row.key === 'overviewBackgroundColor') current.overviewBackgroundColor = OVERVIEW_COLOR_PATTERN.test(row.value) ? row.value : DEFAULT_OVERVIEW_COLOR
          else if (row.key === 'overviewWallpaperId') current.overviewWallpaperId = isWallpaperId(row.value) ? row.value : null
          else if (row.key === 'memoryEmbeddingModel') current.memoryEmbeddingModel = row.value.trim() && row.value.length <= 512 && !/\s/.test(row.value) ? row.value : DEFAULT_EMBEDDING_MODEL
          else if (row.key === 'ollamaBaseUrl') current.ollamaBaseUrl = isOllamaBaseUrl(row.value) ? row.value : DEFAULT_OLLAMA_BASE_URL
          else if (row.key === 'fontSize') current.fontSize = normalizeFontSize(Number(row.value))
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
    if (next.caffeineMode !== undefined) this.activityChanged()
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
    for (const task of this.getTasks()) if (task.projectId === id) this.taskImages.remove(task.id)
    this.db.delete(projects).where(eq(projects.id, id)).run()
    this.activityChanged()
  }

  updateProject(
    id: string,
    patch: Pick<Project, 'monthlyTokenLimit' | 'monthlyCostLimitUsd' | 'finishOnPush'>
  ): Project | undefined {
    this.db.update(projects).set({
      monthlyTokenLimit: patch.monthlyTokenLimit,
      monthlyCostLimitUsd: patch.monthlyCostLimitUsd,
      finishOnPush: patch.finishOnPush
    }).where(eq(projects.id, id)).run()
    const row = this.db.select().from(projects).where(eq(projects.id, id)).get()
    return row ? toProject(row) : undefined
  }

  getTasks(): Task[] {
    return this.db.select().from(tasks).orderBy(desc(tasks.startedAt)).all().map(toTask)
  }

  addTask(task: Task): Task {
    this.db.insert(tasks).values(toTaskRow(task)).run()
    this.activityChanged()
    return task
  }

  /** Foreign keys cascade to task-owned Valence plans, execution metadata, output, and comments. */
  deleteTaskCascade(taskId: string): void {
    this.taskImages.remove(taskId)
    this.db.delete(tasks).where(eq(tasks.id, taskId)).run()
    this.activityChanged()
  }

  updateTask(id: string, patch: Partial<Task>): Task | undefined {
    const current = this.getTask(id)
    if (!current) return undefined
    const next = {
      ...current, ...patch,
      ...(patch.status === 'running' ? { reviewedAt: undefined, settledAt: undefined } : {})
    }
    this.db.update(tasks).set(toTaskRow(next)).where(eq(tasks.id, id)).run()
    if (current.status !== next.status) this.activityChanged()
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
  markCommentsSent(taskId: string, sentAt: number, commentIds?: string[]): TaskComment[] {
    const pending = this.getComments(taskId).filter((comment) => comment.sentAt === null && (!commentIds || commentIds.includes(comment.id)))
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

  /** The tracker borrows Store's migrated connection and cannot close it. */
  issueTracker(projectId: string): IssueTracker {
    return new IssueTracker(this.sqlite, projectId, 'borrowed')
  }

  /** Share one immediate transaction with the borrowed tracker and execution metadata. */
  transaction<Result>(operation: () => Result): Result {
    return this.sqlite.transaction(operation).immediate()
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
