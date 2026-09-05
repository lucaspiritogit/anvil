import Database from 'better-sqlite3'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import * as schema from './db/schema'
import { DEFAULT_KEYBINDINGS, normalizeKeybindings } from '../shared/keybindings'
import type { Project, Run, RunComment, RunEvent, Settings, IssueTracker } from '../shared/types'

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

const { projects, runComments, runEvents, runs, settings } = schema

type ProjectRow = typeof projects.$inferSelect
type RunRow = typeof runs.$inferSelect
type RunCommentRow = typeof runComments.$inferSelect
type RunEventRow = typeof runEvents.$inferSelect

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

function toRun(row: RunRow): Run {
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

function toRunComment(row: RunCommentRow): RunComment {
  return {
    id: row.id,
    runId: row.runId,
    file: row.file,
    side: row.side,
    lineNumber: row.lineNumber,
    body: row.body,
    createdAt: row.createdAt,
    sentAt: row.sentAt
  }
}

function toRunEvent(row: RunEventRow): RunEvent {
  return {
    id: row.id,
    runId: row.runId,
    ts: row.ts,
    stream: row.stream,
    kind: row.kind,
    category: row.category,
    text: row.text
  }
}

/** The row a `Run` writes, with its optional fields collapsed back to null. */
function toRunRow(run: Run): typeof runs.$inferInsert {
  return {
    ...run,
    model: run.model ?? null,
    endedAt: run.endedAt ?? null,
    exitCode: run.exitCode ?? null,
    error: run.error ?? null,
    baseBranch: run.baseBranch ?? null,
    branchName: run.branchName ?? null,
    baseCommit: run.baseCommit ?? null,
    headCommit: run.headCommit ?? null,
    worktreePath: run.worktreePath ?? null,
    deliveryError: run.deliveryError ?? null,
    sessionId: run.sessionId ?? null
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
    this.db = drizzle(this.sqlite, { schema })

    // Foreign keys must be off while migrating: SQLite cannot alter a table in
    // place, so Drizzle rebuilds it (create, copy, drop, rename), which trips
    // any foreign key pointing at it. The pragma is ignored inside a
    // transaction, so it has to be set on the connection beforehand.
    this.sqlite.pragma('foreign_keys = OFF')
    migrate(this.db, { migrationsFolder: options.migrationsFolder })
    this.sqlite.pragma('foreign_keys = ON')

    this.seedSettings()
    this.markInterruptedRunsFailed()
    for (const row of this.db.select().from(schema.taskIssueTrackers).all()) {
      if (row.state.phase === 'planning' || row.state.phase === 'working') {
        this.saveIssueTracker({ ...row.state, phase: 'blocked', error: 'Interrupted by app restart.',
          items: row.state.items.map((item) => item.status === 'working' ? { ...item, status: 'blocked' } : item) })
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

  /** A run cannot outlive the app, so anything still 'running' died with it. */
  private markInterruptedRunsFailed(): void {
    this.db
      .update(runs)
      .set({
        status: 'failed',
        deliveryStatus: 'agent_failed',
        error: 'Interrupted by app restart',
        deliveryError: 'The agent was interrupted before Git delivery completed.',
        endedAt: sql`COALESCE(${runs.endedAt}, ${Date.now()})`
      })
      .where(eq(runs.status, 'running'))
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

  getRuns(): Run[] {
    return this.db.select().from(runs).orderBy(desc(runs.startedAt)).all().map(toRun)
  }

  addRun(run: Run): Run {
    this.db.insert(runs).values(toRunRow(run)).run()
    return run
  }

  updateRun(id: string, patch: Partial<Run>): Run | undefined {
    const current = this.getRun(id)
    if (!current) return undefined
    const next = { ...current, ...patch }
    this.db.update(runs).set(toRunRow(next)).where(eq(runs.id, id)).run()
    return next
  }

  getRun(id: string): Run | undefined {
    const row = this.db.select().from(runs).where(eq(runs.id, id)).get()
    return row ? { ...toRun(row), } : undefined
  }

  /** Every note on a run, drafts and sent alike, oldest first. */
  getComments(runId: string): RunComment[] {
    return this.db
      .select()
      .from(runComments)
      .where(eq(runComments.runId, runId))
      .orderBy(asc(runComments.createdAt))
      .all()
      .map(toRunComment)
  }

  addComment(comment: RunComment): RunComment {
    this.db.insert(runComments).values(comment).run()
    return comment
  }

  removeComment(id: string): void {
    this.db.delete(runComments).where(eq(runComments.id, id)).run()
  }

  /** Marks a run's drafts as sent; returns the comments that were pending. */
  markCommentsSent(runId: string, sentAt: number): RunComment[] {
    const pending = this.getComments(runId).filter((comment) => comment.sentAt === null)
    if (!pending.length) return []
    this.db
      .update(runComments)
      .set({ sentAt })
      .where(
        and(
          eq(runComments.runId, runId),
          isNull(runComments.sentAt),
          inArray(
            runComments.id,
            pending.map((comment) => comment.id)
          )
        )
      )
      .run()
    return pending.map((comment) => ({ ...comment, sentAt }))
  }

  appendEvent(event: RunEvent): void {
    this.db.insert(runEvents).values(event).run()
  }

  readEvents(runId: string): RunEvent[] {
    return this.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, runId))
      .orderBy(asc(runEvents.sequence))
      .all()
      .map(toRunEvent)
  }

  close(): void {
    this.sqlite.close()
  }

  getIssueTracker(runId: string): IssueTracker | undefined {
    return this.db.select().from(schema.taskIssueTrackers).where(eq(schema.taskIssueTrackers.runId, runId)).get()?.state
  }

  saveIssueTracker(tracker: IssueTracker): IssueTracker {
    this.db.insert(schema.taskIssueTrackers).values({ runId: tracker.runId, state: tracker })
      .onConflictDoUpdate({ target: schema.taskIssueTrackers.runId, set: { state: tracker } }).run()
    return tracker
  }
}
