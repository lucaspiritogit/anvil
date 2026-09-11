import { IssueTracker } from './valence/tracker'
import { WorkspaceStorage, type WorkspaceConnection } from './workspace-storage'
import { moveWorkspaceDirectory } from './workspace-directories'
import { normalizeWorkspaceName, readRootConfig, writeRootConfig, type RootConfig } from './root-config'
import { archiveLegacyRoot, migrateLegacyRoot, relocateTaskPaths } from './legacy-root-storage'
import { TaskImageStorage } from './task-image-storage'
import type { PullRequestMerged } from '../shared/github-pull-request-state'
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEFAULT_WORKSPACE_ID, DEFAULT_TASK_EVENT_PAGE_SIZE, MAX_TASK_EVENT_PAGE_SIZE } from '../shared/types'
import type { TaskEventsRequest, TaskEventsPage, TaskEventCursor } from '../shared/types'
import * as schema from './db/schema'
import { canSettleTask, settlementDeadline } from '../shared/task-settlement'
import { advanceTaskWorkingTime, isTaskWorking, type TaskWorkingTime } from '../shared/task-timing'
import { DEFAULT_KEYBINDINGS, normalizeKeybindings } from '../shared/keybindings'
import type { Project, Task, TaskComment, TaskEvent, Settings, TaskExecutionState, Workspace, WorkspacePreferences, ComposerPreferences } from '../shared/types'
import { DEFAULT_FONT_SIZE, normalizeFontSize, DEFAULT_OVERVIEW_COLOR, OVERVIEW_COLOR_PATTERN, isWallpaperId } from '../shared/appearance'
import { DEFAULT_OLLAMA_BASE_URL, DEFAULT_EMBEDDING_MODEL, isOllamaBaseUrl } from '../shared/memory-settings'

const DEFAULT_SETTINGS: Settings = {
  autoCompactContext: true,
  contextCompactionThreshold: 75,
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
  allowOtherDevices: false,
  tailscaleHttps: false,
  keybindings: DEFAULT_KEYBINDINGS
}

/** The settings table stores text, so non-string values are encoded here. */
const SETTING_KEYS = [
  'autoCompactContext',
  'contextCompactionThreshold',
  'memoryEnabled',
  'memoryEmbeddingModel',
  'ollamaBaseUrl',
  'fontSize',
  'defaultAgentId',
  'defaultModel',
  'rebaseMode',
  'confirmRebase',
  'caffeineMode',
  'allowOtherDevices',
  'tailscaleHttps',
  'keybindings',
  'overviewBackgroundMode',
  'overviewBackgroundColor',
  'overviewWallpaperId'
] as const

function encodeSetting(key: keyof Settings, value: Settings[keyof Settings]): string {
  if (key === 'autoCompactContext' || key === 'confirmRebase' || key === 'caffeineMode' || key === 'memoryEnabled' || key === 'allowOtherDevices' || key === 'tailscaleHttps') return String(value === true)
  if (key === 'keybindings') return JSON.stringify(value)
  if (key === 'overviewWallpaperId') return isWallpaperId(value) ? value : ''
  return String(value)
}

function decodeKeybindings(value: string): Settings['keybindings'] {
  try {
    return normalizeKeybindings(JSON.parse(value))
  } catch {
    return structuredClone(DEFAULT_KEYBINDINGS)
  }
}

const { projects, taskComments, taskEvents, tasks, workspaceSettings: settings, workspacePreferences, appState } = schema

type ProjectRow = typeof projects.$inferSelect
type TaskRow = typeof tasks.$inferSelect
type TaskPullRequestRow = typeof schema.taskPullRequests.$inferSelect
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
    workspaceId: row.workspaceId,
    agentId: row.agentId,
    agentLabel: row.agentLabel,
    ...(row.model === null ? {} : { model: row.model }),
    prompt: row.prompt,
    title: row.title,
    cwd: row.cwd,
    status: row.status,
    startedAt: row.startedAt,
    workingTimeMs: row.workingTimeMs,
    ...(row.workingStartedAt === null ? {} : { workingStartedAt: row.workingStartedAt }),
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
    ...(row.contextUsed === null ? {} : { contextUsed: row.contextUsed }),
    ...(row.contextSize === null ? {} : { contextSize: row.contextSize }),
    ...(row.contextCompactionError === null ? {} : { contextCompactionError: row.contextCompactionError }),
    ...(row.parentTaskId === null ? {} : { parentTaskId: row.parentTaskId }),
    ...(row.expectedFiles === null ? {} : { expectedFiles: row.expectedFiles }),
    ...(row.restackState === null ? {} : { restackState: row.restackState }),
    ...(row.restackTarget === null ? {} : { restackTarget: row.restackTarget }),
    ...(row.stackSuggestion === null ? {} : { stackSuggestion: row.stackSuggestion }),
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

function withCurrentPullRequest(task: Task, link: TaskPullRequestRow | undefined): Task {
  if (!link || task.status !== 'succeeded' || task.deliveryStatus !== 'reviewable' || task.headCommit !== link.headSha) return task
  return {
    ...task,
    pullRequest: {
      number: link.number,
      url: `https://github.com/${link.repository}/pull/${link.number}`
    }
  }
}

function withoutPullRequest(task: Task): Task {
  const persistedTask = { ...task }
  delete persistedTask.pullRequest
  return persistedTask
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
    ...withoutPullRequest(task),
    parentTaskId: task.parentTaskId ?? null,
    expectedFiles: task.expectedFiles ?? null,
    restackState: task.restackState ?? null,
    restackTarget: task.restackTarget ?? null,
    stackSuggestion: task.stackSuggestion ?? null,
    model: task.model ?? null,
    endedAt: task.endedAt ?? null,
    workingTimeMs: task.workingTimeMs ?? 0,
    workingStartedAt: task.workingStartedAt ?? null,
    reviewedAt: task.reviewedAt ?? null,
    settledAt: task.settledAt ?? null,
    exitCode: task.exitCode ?? null,
    error: task.error ?? null,
    baseBranch: task.baseBranch ?? null,
    branchName: task.branchName ?? null,
    baseCommit: task.baseCommit ?? null,
    headCommit: task.headCommit ?? null,
    deliveryError: task.deliveryError ?? null,
    contextUsed: task.contextUsed ?? null,
    contextSize: task.contextSize ?? null,
    contextCompactionError: task.contextCompactionError ?? null,
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
  private readonly dataDirectory: string
  private readonly temporaryDirectory: boolean
  private readonly configFile: string
  private config: RootConfig
  private readonly storage: WorkspaceStorage
  private readonly initializedWorkspaces = new Set<string>()
  private activityDepth = 0
  private closed = false
  private readonly activityListeners = new Set<() => void>()

  /** Observe committed task/issue state and settings that control task activity. */
  subscribeActivity(listener: () => void): () => void {
    this.activityListeners.add(listener)
    return () => { this.activityListeners.delete(listener) }
  }

  /** Also publish after transient execution guards clear without a database write. */
  activityChanged(): void {
    if (this.activityDepth) return
    for (const listener of this.activityListeners) {
      try { listener() } catch (error) { console.warn('Store activity listener failed:', error) }
    }
  }

  hasRunningTasks(workspaceId?: string): boolean {
    return this.getTasks(workspaceId).some((task) => task.status === 'running')
  }

  readonly taskImages: TaskImageStorage

  constructor(databaseFile: string, options: StoreOptions) {
    this.temporaryDirectory = databaseFile === ':memory:'
    this.dataDirectory = this.temporaryDirectory ? mkdtempSync(join(tmpdir(), 'anvil-store-')) : dirname(databaseFile)
    this.taskImages = new TaskImageStorage((taskId) => {
      const task = this.getTask(taskId)
      const workspaceId = task?.workspaceId ?? this.getActiveWorkspace().id
      return join(this.getWorkspaceDirectory(workspaceId), 'anvil.db.images')
    })
    this.configFile = databaseFile.endsWith('.json') ? databaseFile : join(this.dataDirectory, 'config.json')
    // Accept old Store callers while the on-disk root registry migrates to JSON.
    const legacyDatabase = databaseFile.endsWith('.json') || this.temporaryDirectory
      ? join(this.dataDirectory, 'anvil.db') : databaseFile
    if (existsSync(this.configFile)) {
      this.config = readRootConfig(this.configFile)
    } else if (existsSync(legacyDatabase)) {
      this.config = migrateLegacyRoot(legacyDatabase, options.migrationsFolder)
    } else {
      this.config = {
        version: 1,
        workspaces: [{ id: DEFAULT_WORKSPACE_ID, name: 'Default', createdAt: Date.now() }],
        activeWorkspaceId: DEFAULT_WORKSPACE_ID
      }
    }
    this.storage = new WorkspaceStorage(this.dataDirectory, options.migrationsFolder,
      (id) => this.getWorkspaceDirectory(id), (id) => this.requireWorkspace(id))
    try {
      this.workspaceConnection(this.getActiveWorkspace().id)
      writeRootConfig(this.configFile, this.config)
      archiveLegacyRoot(legacyDatabase)
    } catch (error) {
      this.storage.close()
      throw error
    }
  }

  private seedWorkspace(workspaceId: string, db: BetterSQLite3Database<typeof schema>): void {
    db.insert(settings).values(
      SETTING_KEYS.map((key) => ({ workspaceId, key, value: encodeSetting(key, DEFAULT_SETTINGS[key]) }))
    ).onConflictDoNothing().run()
    db.insert(workspacePreferences).values({
      workspaceId,
      composer: { agentId: '', modelsByAgent: {}, reasoningByAgentModel: {} },
      lastProjectId: null
    }).onConflictDoNothing().run()
  }

  getWorkspaces(): Workspace[] {
    return structuredClone(this.config.workspaces).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
  }

  /** Background work spans workspaces already used during this app session. */
  getOpenedWorkspaces(): Workspace[] {
    return this.getWorkspaces().filter((workspace) => this.initializedWorkspaces.has(workspace.id))
  }

  private requireWorkspace(id: string): Workspace {
    const workspace = this.getWorkspaces().find((entry) => entry.id === id)
    if (!workspace) throw new Error('Workspace not found')
    return workspace
  }

  private saveConfig(config: RootConfig): void {
    writeRootConfig(this.configFile, config)
    this.config = config
  }

  createWorkspace(name: string): Workspace {
    const normalized = normalizeWorkspaceName(name)
    if (this.getWorkspaces().some((workspace) => workspace.name.toLowerCase() === normalized.nameKey)) {
      throw new Error('A workspace with that name already exists')
    }
    const directory = join(this.dataDirectory, 'workspaces', normalized.name)
    if (existsSync(directory)) throw new Error('The workspace destination folder already exists')
    const workspace = { id: randomUUID(), name: normalized.name, createdAt: Date.now() }
    const previous = this.config
    this.config = { ...previous, workspaces: [...previous.workspaces, workspace] }
    try {
      this.workspaceConnection(workspace.id)
      this.saveConfig(this.config)
    } catch (error) {
      this.config = previous
      this.initializedWorkspaces.delete(workspace.id)
      this.storage.closeWorkspace(workspace.id)
      rmSync(directory, { recursive: true, force: true })
      throw error
    }
    return { ...workspace }
  }

  renameWorkspace(id: string, name: string): Workspace {
    this.requireWorkspace(id)
    const normalized = normalizeWorkspaceName(name)
    const duplicate = this.getWorkspaces().find((workspace) => workspace.name.toLowerCase() === normalized.nameKey)
    if (duplicate && duplicate.id !== id) throw new Error('A workspace with that name already exists')
    if (this.hasRunningTasks(id)) throw new Error('Wait for running tasks in this workspace to finish before renaming it')
    const previous = this.getWorkspaceDirectory(id)
    const directory = join(this.dataDirectory, 'workspaces', normalized.name)
    this.storage.closeWorkspace(id)
    moveWorkspaceDirectory(previous, directory)
    try {
      this.saveConfig({ ...this.config, workspaces: this.config.workspaces.map((workspace) =>
        workspace.id === id ? { ...workspace, name: normalized.name } : workspace) })
    } catch (error) {
      moveWorkspaceDirectory(directory, previous)
      throw error
    }
    relocateTaskPaths(this.storage.open(id).sqlite, previous, directory)
    return this.requireWorkspace(id)
  }

  getActiveWorkspace(): Workspace {
    return this.requireWorkspace(this.config.activeWorkspaceId)
  }

  selectWorkspace(id: string): Workspace {
    const workspace = this.requireWorkspace(id)
    this.workspaceConnection(id)
    this.saveConfig({ ...this.config, activeWorkspaceId: id })
    this.activityChanged()
    return workspace
  }

  /** Workspace IDs own records; the user-visible name owns the folder. */
  getWorkspaceDirectory(workspaceId: string): string {
    const workspace = this.requireWorkspace(workspaceId)
    const normalized = normalizeWorkspaceName(workspace.name)
    return join(this.dataDirectory, 'workspaces', normalized.name)
  }

  getWorkspacePreferences(workspaceId = this.getActiveWorkspace().id): WorkspacePreferences {
    const db = this.workspaceConnection(workspaceId).db
    this.requireWorkspace(workspaceId)
    const row = db.select().from(workspacePreferences).where(eq(workspacePreferences.workspaceId, workspaceId)).get()!
    return { composer: structuredClone(row.composer), lastProjectId: row.lastProjectId }
  }

  setWorkspacePreferences(next: Partial<WorkspacePreferences>, workspaceId = this.getActiveWorkspace().id): WorkspacePreferences {
    const db = this.workspaceConnection(workspaceId).db
    this.requireWorkspace(workspaceId)
    if (next.composer !== undefined) this.validateComposerPreferences(next.composer)
    if (next.composer === undefined && next.lastProjectId === undefined) return this.getWorkspacePreferences(workspaceId)
    return db.transaction(() => {
      db.update(workspacePreferences).set({
        ...(next.composer === undefined ? {} : { composer: structuredClone(next.composer) }),
        ...(next.lastProjectId === undefined ? {} : { lastProjectId: next.lastProjectId })
      }).where(eq(workspacePreferences.workspaceId, workspaceId)).run()
      if (next.composer !== undefined && workspaceId === DEFAULT_WORKSPACE_ID) {
        db.insert(appState).values({ key: 'legacyComposerImported', value: 'true' }).onConflictDoNothing().run()
      }
      return this.getWorkspacePreferences(workspaceId)
    })
  }

  /** Import and marker commit together; explicit SQLite choices always win. */
  importLegacyComposerPreferences(composer: ComposerPreferences): WorkspacePreferences {
    this.validateComposerPreferences(composer)
    const db = this.workspaceConnection(DEFAULT_WORKSPACE_ID).db
    return db.transaction(() => {
      const key = 'legacyComposerImported'
      const marker = db.select().from(appState).where(eq(appState.key, key)).get()
      if (!marker) {
        const current = this.getWorkspacePreferences(DEFAULT_WORKSPACE_ID).composer
        if (!current.agentId && !Object.keys(current.modelsByAgent).length && !Object.keys(current.reasoningByAgentModel).length) {
          this.setWorkspacePreferences({ composer }, DEFAULT_WORKSPACE_ID)
        }
        db.insert(appState).values({ key, value: 'true' }).onConflictDoNothing().run()
      }
      return this.getWorkspacePreferences(DEFAULT_WORKSPACE_ID)
    })
  }

  private validateComposerPreferences(composer: ComposerPreferences): void {
    const stringRecord = (value: unknown): boolean => Boolean(value && typeof value === 'object' &&
      !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === 'string'))
    if (!composer || typeof composer.agentId !== 'string' || !stringRecord(composer.modelsByAgent) ||
        !stringRecord(composer.reasoningByAgentModel)) {
      throw new Error('Invalid composer preferences')
    }
  }

  /** A task cannot outlive the app, so anything still 'running' died with it. */
  private recoverInterruptedTasks(workspaceId: string): void {
    for (const task of this.getTasks(workspaceId)) {
      const unfinishedDelivery = ['preparing', 'working', 'finalizing', 'did_not_commit'].includes(task.deliveryStatus)
      if (task.status !== 'running' && !unfinishedDelivery) continue
      // Old versions used cancellation for shutdown too. An unfinished delivery
      // without an explicit Stop event is recoverable after restart.
      const stoppedByUser = task.status === 'cancelled' && this.hasUserStopEvent(task.id)
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
    const db = this.taskConnection(taskId).db
    db.insert(schema.taskPullRequests).values({ ...link, taskId, repository: link.repository.toLowerCase() })
      .onConflictDoUpdate({ target: schema.taskPullRequests.taskId, set: { ...link, repository: link.repository.toLowerCase() } }).run()
  }

  getPullRequestsToRefresh(workspaceId?: string): (Omit<PullRequestMerged, 'mergedAt'> & { taskId: string })[] {
    if (workspaceId === undefined) return this.getOpenedWorkspaces().flatMap((workspace) => this.getPullRequestsToRefresh(workspace.id))
    const db = this.workspaceConnection(workspaceId).db
    return db.select().from(schema.taskPullRequests).all().filter((link) => {
      const task = this.getTask(link.taskId)
      return task?.status === 'succeeded' && task.deliveryStatus === 'reviewable' && task.headCommit === link.headSha
    })
  }

  approveMergedPullRequest(event: PullRequestMerged, workspaceId?: string): Task[] {
    if (workspaceId === undefined) return this.getOpenedWorkspaces().flatMap((workspace) => this.approveMergedPullRequest(event, workspace.id))
    const db = this.workspaceConnection(workspaceId).db
    return db.transaction(() => {
      const links = db.select().from(schema.taskPullRequests).where(and(
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

  getSettings(workspaceId = this.getActiveWorkspace().id): Settings {
    const db = this.workspaceConnection(workspaceId).db
    this.requireWorkspace(workspaceId)
    return db
      .select()
      .from(settings)
      .where(eq(settings.workspaceId, workspaceId))
      .all()
      .reduce<Settings>(
        (current, row) => {
          if (row.key === 'autoCompactContext' || row.key === 'confirmRebase' || row.key === 'caffeineMode' || row.key === 'memoryEnabled' || row.key === 'allowOtherDevices' || row.key === 'tailscaleHttps') current[row.key] = row.value === 'true'
          else if (row.key === 'overviewBackgroundMode') current.overviewBackgroundMode = row.value === 'image' ? 'image' : 'color'
          else if (row.key === 'overviewBackgroundColor') current.overviewBackgroundColor = OVERVIEW_COLOR_PATTERN.test(row.value) ? row.value : DEFAULT_OVERVIEW_COLOR
          else if (row.key === 'overviewWallpaperId') current.overviewWallpaperId = isWallpaperId(row.value) ? row.value : null
          else if (row.key === 'memoryEmbeddingModel') current.memoryEmbeddingModel = row.value.trim() && row.value.length <= 512 && !/\s/.test(row.value) ? row.value : DEFAULT_EMBEDDING_MODEL
          else if (row.key === 'ollamaBaseUrl') current.ollamaBaseUrl = isOllamaBaseUrl(row.value) ? row.value : DEFAULT_OLLAMA_BASE_URL
          else if (row.key === 'contextCompactionThreshold') current.contextCompactionThreshold = Number(row.value) >= 1 && Number(row.value) <= 100 ? Number(row.value) : 75
          else if (row.key === 'fontSize') current.fontSize = normalizeFontSize(Number(row.value))
          else if (row.key === 'keybindings') current.keybindings = decodeKeybindings(row.value)
          else if (row.key === 'rebaseMode') {
            current.rebaseMode = row.value === 'agent' ? 'agent' : 'manual'
          } else if (row.key === 'defaultAgentId' || row.key === 'defaultModel') {
            current[row.key] = row.value
          }
          return current
        },
        structuredClone(DEFAULT_SETTINGS)
      )
  }

  setSettings(next: Partial<Settings>, workspaceId = this.getActiveWorkspace().id): Settings {
    const db = this.workspaceConnection(workspaceId).db
    this.requireWorkspace(workspaceId)
    if (next.autoCompactContext !== undefined && typeof next.autoCompactContext !== 'boolean') throw new Error('Auto-compaction must be a boolean')
    if (next.tailscaleHttps !== undefined && typeof next.tailscaleHttps !== 'boolean') throw new Error('Tailscale HTTPS must be a boolean')
    if (next.allowOtherDevices !== undefined && typeof next.allowOtherDevices !== 'boolean') throw new Error('Allow other devices must be a boolean')
    if (next.contextCompactionThreshold !== undefined && (!Number.isInteger(next.contextCompactionThreshold) || next.contextCompactionThreshold < 1 || next.contextCompactionThreshold > 100)) throw new Error('Context threshold must be an integer from 1 to 100')
    const rows = SETTING_KEYS.filter((key) => next[key] !== undefined).map((key) => ({
      workspaceId,
      key,
      value: encodeSetting(key, next[key]!)
    }))
    if (rows.length) {
      db.transaction((tx) => {
        for (const row of rows) {
          tx.insert(settings)
            .values(row)
            .onConflictDoUpdate({ target: [settings.workspaceId, settings.key], set: { value: row.value } })
            .run()
        }
      })
    }
    if (next.caffeineMode !== undefined) this.activityChanged()
    return this.getSettings(workspaceId)
  }

  getProjects(workspaceId = this.getActiveWorkspace().id): Project[] {
    const db = this.workspaceConnection(workspaceId).db
    return db.select().from(projects).orderBy(asc(projects.createdAt)).all().map(toProject)
  }

  addProject(project: Project, workspaceId = this.getActiveWorkspace().id): Project {
    const db = this.workspaceConnection(workspaceId).db
    db.insert(projects).values(project).onConflictDoNothing().run()
    // The insert is a no-op when the path is already tracked, so the stored row
    // is the answer either way.
    const row = db.select().from(projects).where(eq(projects.path, project.path)).get()!
    return toProject(row)
  }

  removeProject(id: string, workspaceId = this.getActiveWorkspace().id): void {
    const db = this.workspaceConnection(workspaceId).db
    for (const task of this.getTasks(workspaceId)) if (task.projectId === id) this.taskImages.remove(task.id)
    db.delete(projects).where(eq(projects.id, id)).run()
    this.activityChanged()
  }

  updateProject(
    id: string,
    patch: Partial<Pick<Project, 'monthlyTokenLimit' | 'monthlyCostLimitUsd' | 'finishOnPush'>>,
    workspaceId = this.getActiveWorkspace().id
  ): Project | undefined {
    const db = this.workspaceConnection(workspaceId).db
    if (patch.monthlyTokenLimit === undefined && patch.monthlyCostLimitUsd === undefined && patch.finishOnPush === undefined) {
      return this.getProjects(workspaceId).find((project) => project.id === id)
    }
    db.update(projects).set({
      monthlyTokenLimit: patch.monthlyTokenLimit,
      monthlyCostLimitUsd: patch.monthlyCostLimitUsd,
      finishOnPush: patch.finishOnPush
    }).where(eq(projects.id, id)).run()
    const row = db.select().from(projects).where(eq(projects.id, id)).get()
    return row ? toProject(row) : undefined
  }

  getTasks(workspaceId?: string): Task[] {
    if (workspaceId === undefined) {
      return this.getOpenedWorkspaces().flatMap((workspace) => this.getTasks(workspace.id)).sort((a, b) => b.startedAt - a.startedAt)
    }
    const db = this.workspaceConnection(workspaceId).db
    const pullRequests = new Map(db.select().from(schema.taskPullRequests).all().map((link) => [link.taskId, link]))
    return db.select().from(tasks).orderBy(desc(tasks.startedAt)).all()
      .map((row) => withCurrentPullRequest(toTask(row), pullRequests.get(row.id)))
  }

  addTask(task: Omit<Task, 'workspaceId'> & { workspaceId?: string }): Task {
    const ownedTask: Task = {
      ...task, workspaceId: task.workspaceId ?? this.getActiveWorkspace().id,
      ...advanceTaskWorkingTime({ workingTimeMs: task.workingTimeMs }, isTaskWorking(task), Date.now())
    }
    const connection = this.workspaceConnection(ownedTask.workspaceId)
    if (this.getTask(ownedTask.id)) throw new Error('Task already exists')
    connection.db.insert(tasks).values(toTaskRow(ownedTask)).run()
    this.activityChanged()
    return ownedTask
  }

  /** Foreign keys cascade to task-owned Valence plans, execution metadata, output, and comments. */
  deleteTaskCascade(taskId: string): void {
    if (!this.getTask(taskId)) return
    const db = this.taskConnection(taskId).db
    this.taskImages.remove(taskId)
    db.delete(tasks).where(eq(tasks.id, taskId)).run()
    this.activityChanged()
  }

  updateTask(id: string, patch: Partial<Omit<Task, 'workspaceId' | 'pullRequest'>>, restoreTiming?: TaskWorkingTime): Task | undefined {
    const current = this.getTask(id)
    if (!current) return undefined
    const db = this.workspaceConnection(current.workspaceId).db
    if ('workspaceId' in patch && patch.workspaceId !== current.workspaceId) {
      throw new Error('Task workspace ownership cannot change')
    }
    const next = {
      ...withoutPullRequest(current), ...patch,
      ...(patch.status === 'running' ? { reviewedAt: undefined, settledAt: undefined } : {})
    }
    // Full task snapshots are used by callers; only explicit dispatch rollback
    // may restore a timing snapshot instead of advancing the current measurement.
    Object.assign(next, advanceTaskWorkingTime(restoreTiming ?? current, isTaskWorking(next, this.getTaskExecution(id)), Date.now()))
    db.update(tasks).set(toTaskRow(next)).where(eq(tasks.id, id)).run()
    if (current.status !== next.status || current.deliveryStatus !== next.deliveryStatus) this.activityChanged()
    const link = db.select().from(schema.taskPullRequests).where(eq(schema.taskPullRequests.taskId, id)).get()
    return withCurrentPullRequest(next, link)
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
    return this.getTasks().flatMap((task) => {
      const deadline = settlementDeadline(task)
      return deadline !== undefined && deadline <= now ? [this.settleTask(task.id, deadline)] : []
    })
  }

  getTask(id: string): Task | undefined {
    for (const workspace of this.getOpenedWorkspaces()) {
      const db = this.storage.open(workspace.id).db
      const row = db.select().from(tasks).where(eq(tasks.id, id)).get()
      if (row) {
        const link = db.select().from(schema.taskPullRequests).where(eq(schema.taskPullRequests.taskId, id)).get()
        return withCurrentPullRequest(toTask(row), link)
      }
    }
    return undefined
  }

  /** Every note on a task, drafts and sent alike, oldest first. */
  getComments(taskId: string): TaskComment[] {
    if (!this.getTask(taskId)) return []
    const db = this.taskConnection(taskId).db
    return db
      .select()
      .from(taskComments)
      .where(eq(taskComments.taskId, taskId))
      .orderBy(asc(taskComments.createdAt))
      .all()
      .map(toTaskComment)
  }

  addComment(comment: TaskComment): TaskComment {
    const db = this.taskConnection(comment.taskId).db
    db.insert(taskComments).values(comment).run()
    return comment
  }

  removeComment(id: string): void {
    for (const workspace of this.getOpenedWorkspaces()) {
      this.workspaceConnection(workspace.id).db.delete(taskComments).where(eq(taskComments.id, id)).run()
    }
  }

  /** Marks a task's drafts as sent; returns the comments that were pending. */
  markCommentsSent(taskId: string, sentAt: number, commentIds?: string[]): TaskComment[] {
    const db = this.taskConnection(taskId).db
    const pending = this.getComments(taskId).filter((comment) => comment.sentAt === null && (!commentIds || commentIds.includes(comment.id)))
    if (!pending.length) return []
    db
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

  appendEvent(event: TaskEvent): TaskEvent & { sequence: number } {
    const db = this.taskConnection(event.taskId).db
    // Tool snapshots replace their prior row without changing insertion order.
    const { sequence: _sequence, ...input } = event
    const row = db.insert(taskEvents).values(input).onConflictDoUpdate({
      target: taskEvents.id,
      set: { text: event.text, category: event.category, stream: event.stream }
    }).returning().get()
    return { ...toTaskEvent(row), sequence: row.sequence }
  }

  private hasUserStopEvent(taskId: string): boolean {
    return !!this.taskConnection(taskId).db.select({ sequence: taskEvents.sequence }).from(taskEvents)
      .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.text, 'Stop requested by user.'))).limit(1).get()
  }

  /** Bounded compatibility API for array consumers. */
  readEvents(taskId: string, limit = DEFAULT_TASK_EVENT_PAGE_SIZE): TaskEvent[] {
    return this.readEventsPage({ taskId, limit }).events.map(({ sequence: _sequence, ...event }) => event)
  }

  readEventsPage({ taskId, limit = DEFAULT_TASK_EVENT_PAGE_SIZE, before, after }: TaskEventsRequest): TaskEventsPage {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TASK_EVENT_PAGE_SIZE) throw new Error('Invalid event page limit')
    if (before !== undefined && after !== undefined) throw new Error('Specify only one event cursor')
    for (const cursor of [before, after]) {
      if (cursor !== undefined && (!cursor || cursor.taskId !== taskId || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 1)) {
        throw new Error('Invalid task event cursor')
      }
    }
    const empty: TaskEventsPage = { events: [], oldestCursor: null, newestCursor: null, hasOlder: false, hasNewer: false }
    if (!this.getTask(taskId)) return empty
    const connection = this.taskConnection(taskId)
    // Keep rows and navigation metadata in the same read snapshot.
    return connection.sqlite.transaction(() => {
      const scope = eq(taskEvents.taskId, taskId)
      const rows = connection.db.select().from(taskEvents).where(and(scope,
        before ? lt(taskEvents.sequence, before.sequence) : after ? gt(taskEvents.sequence, after.sequence) : undefined
      )).orderBy(after ? asc(taskEvents.sequence) : desc(taskEvents.sequence)).limit(limit).all()
      if (!after) rows.reverse()
      const cursor = (row: TaskEventRow | undefined): TaskEventCursor | null => row ? { taskId, sequence: row.sequence } : null
      const oldestCursor = cursor(rows[0])
      const newestCursor = cursor(rows.at(-1))
      const anchor = before ?? after
      const oldest = oldestCursor?.sequence ?? anchor?.sequence
      const newest = newestCursor?.sequence ?? anchor?.sequence
      const exists = (condition: ReturnType<typeof lt>): boolean => !!connection.db.select({ sequence: taskEvents.sequence })
        .from(taskEvents).where(and(scope, condition)).limit(1).get()
      return {
        events: rows.map((row) => ({ ...toTaskEvent(row), sequence: row.sequence })), oldestCursor, newestCursor,
        hasOlder: oldest !== undefined && exists(lt(taskEvents.sequence, oldest)),
        hasNewer: newest !== undefined && exists(gt(taskEvents.sequence, newest))
      }
    })()
  }

  /** Select messages before applying the bound so tool traffic cannot crowd out the final summary. */
  readMessageTail(taskId: string): TaskEvent[] {
    if (!this.getTask(taskId)) return []
    const db = this.taskConnection(taskId).db
    return db
      .select()
      .from(taskEvents)
      .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.category, 'message'), sql`length(trim(${taskEvents.text})) > 0`))
      .orderBy(desc(taskEvents.sequence))
      .limit(DEFAULT_TASK_EVENT_PAGE_SIZE)
      .all()
      .reverse()
      .map(toTaskEvent)
  }

  /** The tracker borrows Store's migrated connection and cannot close it. */
  issueTracker(projectId: string, workspaceId = this.getActiveWorkspace().id): IssueTracker {
    return new IssueTracker(this.workspaceConnection(workspaceId).sqlite, projectId, 'borrowed')
  }

  /** Share one immediate transaction with the borrowed tracker and execution metadata. */
  transaction<Result>(operation: () => Result, workspaceId = this.getActiveWorkspace().id): Result {
    const connection = this.workspaceConnection(workspaceId)
    const changes = () => (connection.sqlite.prepare('SELECT total_changes() AS count').get() as { count: number }).count
    const before = changes()
    this.activityDepth++
    let committed = false
    try {
      const result = connection.sqlite.transaction(operation).immediate()
      committed = true
      return result
    } finally {
      this.activityDepth--
      // Nested changes are observed only after the outer transaction commits.
      if (committed && changes() !== before) this.activityChanged()
    }
  }

  getWorkspaceDatabasePath(workspaceId: string): string {
    return join(this.getWorkspaceDirectory(workspaceId), 'anvil.db')
  }

  private workspaceConnection(workspaceId: string): WorkspaceConnection {
    this.requireWorkspace(workspaceId)
    const connection = this.storage.open(workspaceId)
    if (this.initializedWorkspaces.has(workspaceId)) return connection
    // Recovery calls Store methods, so mark this workspace before entering it.
    this.initializedWorkspaces.add(workspaceId)
    try {
      this.seedWorkspace(workspaceId, connection.db)
      // An open interval has no reliable end after a crash. Retain checkpoints,
      // but never turn closed-app downtime into measured work during recovery.
      connection.db.update(tasks).set({ workingStartedAt: null }).where(isNotNull(tasks.workingStartedAt)).run()
      this.recoverInterruptedTasks(workspaceId)
      new TaskImageStorage(join(this.getWorkspaceDirectory(workspaceId), 'anvil.db.images')).prune(
        new Set(this.getTasks(workspaceId).filter((task) => task.status !== 'cancelled' && task.deliveryStatus !== 'failed').map((task) => task.id))
      )
      // Restart stops Anvil execution, not other clients sharing Valence storage.
      for (const row of connection.db.select().from(schema.taskExecutions).all()) {
        if (row.state.phase === 'planning' || row.state.phase === 'working' || row.state.phase === 'recovering') {
          this.saveTaskExecution({ ...row.state, phase: 'blocked', error: 'Interrupted by app restart. Inspect Valence work before requeueing.' })
        }
      }
      return connection
    } catch (error) {
      this.initializedWorkspaces.delete(workspaceId)
      this.storage.closeWorkspace(workspaceId)
      throw error
    }
  }

  private taskConnection(taskId: string): WorkspaceConnection {
    const task = this.getTask(taskId)
    if (!task) throw new Error('Task not found')
    return this.workspaceConnection(task.workspaceId)
  }

  close(): void {
    if (this.closed) return
    const now = Date.now()
    for (const workspaceId of this.initializedWorkspaces) {
      const db = this.storage.open(workspaceId).db
      db.transaction(() => {
        for (const row of db.select().from(tasks).where(isNotNull(tasks.workingStartedAt)).all()) {
          const timing = advanceTaskWorkingTime(toTask(row), false, now)
          db.update(tasks).set({ workingTimeMs: timing.workingTimeMs, workingStartedAt: null }).where(eq(tasks.id, row.id)).run()
        }
      })
    }
    this.storage.close()
    this.closed = true
    if (this.temporaryDirectory) rmSync(this.dataDirectory, { recursive: true, force: true })
  }

  getTaskExecution(taskId: string): TaskExecutionState | undefined {
    if (!this.getTask(taskId)) return undefined
    const db = this.taskConnection(taskId).db
    return db.select().from(schema.taskExecutions).where(eq(schema.taskExecutions.taskId, taskId)).get()?.state
  }

  saveTaskExecution(state: TaskExecutionState): TaskExecutionState {
    const task = this.getTask(state.taskId)
    if (!task) throw new Error('Task not found')
    return this.transaction(() => {
      const db = this.taskConnection(state.taskId).db
      db.insert(schema.taskExecutions).values({ taskId: state.taskId, state })
        .onConflictDoUpdate({ target: schema.taskExecutions.taskId, set: { state } }).run()
      this.updateTask(state.taskId, {})
      return state
    }, task.workspaceId)
  }

}
