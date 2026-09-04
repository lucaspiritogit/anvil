import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Project, Run, RunEvent, Settings } from '../shared/types'

const DEFAULT_SETTINGS: Settings = {
  defaultAgentId: 'opencode',
  defaultModel: 'openrouter/google/gemini-2.5-flash'
}

const SCHEMA_VERSION = 3

interface ProjectRow {
  id: string
  name: string
  path: string
  created_at: number
  monthly_token_limit: number | null
  monthly_cost_limit_usd: number | null
  finish_on_push: number
  git_platform: Project['gitPlatform']
}

interface RunRow {
  id: string
  project_id: string
  agent_id: string
  agent_label: string
  model: string | null
  prompt: string
  title: string
  cwd: string
  status: Run['status']
  started_at: number
  ended_at: number | null
  exit_code: number | null
  error: string | null
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  total_tokens: number
  cost_usd: number | null
  delivery_status: Run['deliveryStatus']
  base_branch: string | null
  branch_name: string | null
  base_commit: string | null
  head_commit: string | null
  worktree_path: string | null
  files_changed: number
  additions: number
  deletions: number
  delivery_error: string | null
}

interface RunEventRow {
  id: string
  run_id: string
  ts: number
  stream: RunEvent['stream']
  kind: RunEvent['kind']
  text: string
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: row.created_at,
    monthlyTokenLimit: row.monthly_token_limit,
    monthlyCostLimitUsd: row.monthly_cost_limit_usd,
    finishOnPush: row.finish_on_push === 1,
    gitPlatform: row.git_platform
  }
}

function toRun(row: RunRow): Run {
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    agentLabel: row.agent_label,
    ...(row.model === null ? {} : { model: row.model }),
    prompt: row.prompt,
    title: row.title,
    cwd: row.cwd,
    status: row.status,
    startedAt: row.started_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    exitCode: row.exit_code,
    ...(row.error === null ? {} : { error: row.error }),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedTokens: row.cached_tokens,
    totalTokens: row.total_tokens,
    costUsd: row.cost_usd,
    deliveryStatus: row.delivery_status,
    ...(row.base_branch === null ? {} : { baseBranch: row.base_branch }),
    ...(row.branch_name === null ? {} : { branchName: row.branch_name }),
    ...(row.base_commit === null ? {} : { baseCommit: row.base_commit }),
    ...(row.head_commit === null ? {} : { headCommit: row.head_commit }),
    ...(row.worktree_path === null ? {} : { worktreePath: row.worktree_path }),
    filesChanged: row.files_changed,
    additions: row.additions,
    deletions: row.deletions,
    ...(row.delivery_error === null ? {} : { deliveryError: row.delivery_error })
  }
}

function toRunEvent(row: RunEventRow): RunEvent {
  return {
    id: row.id,
    runId: row.run_id,
    ts: row.ts,
    stream: row.stream,
    kind: row.kind,
    text: row.text
  }
}

export class Store {
  private readonly db: Database.Database

  constructor(databaseFile: string) {
    mkdirSync(dirname(databaseFile), { recursive: true })
    this.db = new Database(databaseFile)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('synchronous = NORMAL')
    this.createSchema()
    this.migrateSchema()
    this.seedSettings()
    this.markInterruptedRunsFailed()
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        monthly_token_limit INTEGER,
        monthly_cost_limit_usd REAL,
        finish_on_push INTEGER NOT NULL DEFAULT 0 CHECK (finish_on_push IN (0, 1)),
        git_platform TEXT NOT NULL DEFAULT 'github' CHECK (git_platform IN ('github'))
      );

      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        agent_label TEXT NOT NULL,
        model TEXT,
        prompt TEXT NOT NULL,
        title TEXT NOT NULL,
        cwd TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        exit_code INTEGER,
        error TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cached_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        delivery_status TEXT NOT NULL DEFAULT 'unavailable' CHECK (
          delivery_status IN (
            'preparing', 'working', 'finalizing', 'did_not_commit', 'reviewable', 'no_changes',
            'agent_failed', 'failed', 'unavailable'
          )
        ),
        base_branch TEXT,
        branch_name TEXT,
        base_commit TEXT,
        head_commit TEXT,
        worktree_path TEXT,
        files_changed INTEGER NOT NULL DEFAULT 0,
        additions INTEGER NOT NULL DEFAULT 0,
        deletions INTEGER NOT NULL DEFAULT 0,
        delivery_error TEXT
      );

      CREATE INDEX IF NOT EXISTS runs_project_started_idx
        ON runs(project_id, started_at DESC);

      CREATE TABLE IF NOT EXISTS run_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        ts INTEGER NOT NULL,
        stream TEXT NOT NULL CHECK (stream IN ('stdout', 'stderr', 'system')),
        kind TEXT NOT NULL DEFAULT 'output' CHECK (kind IN ('output', 'did_not_commit', 'delivery')),
        text TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS run_events_run_sequence_idx
        ON run_events(run_id, sequence);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
  }

  private migrateSchema(): void {
    const version = this.db.pragma('user_version', { simple: true }) as number
    if (version > SCHEMA_VERSION) {
      throw new Error(`Database schema ${version} is newer than this version of Anvil`)
    }
    if (version === SCHEMA_VERSION) return

    const columns = (table: 'projects' | 'runs' | 'run_events'): Set<string> =>
      new Set(
        (this.db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((column) =>
          column.name.toLowerCase()
        )
      )

    this.db.transaction(() => {
      const projectColumns = columns('projects')
      if (!projectColumns.has('monthly_token_limit')) {
        this.db.exec('ALTER TABLE projects ADD COLUMN monthly_token_limit INTEGER')
      }
      if (!projectColumns.has('monthly_cost_limit_usd')) {
        this.db.exec('ALTER TABLE projects ADD COLUMN monthly_cost_limit_usd REAL')
      }
      if (!projectColumns.has('finish_on_push')) {
        this.db.exec('ALTER TABLE projects ADD COLUMN finish_on_push INTEGER NOT NULL DEFAULT 0')
      }
      if (!projectColumns.has('git_platform')) {
        this.db.exec("ALTER TABLE projects ADD COLUMN git_platform TEXT NOT NULL DEFAULT 'github'")
      }

      const runColumns = columns('runs')
      if (!runColumns.has('input_tokens')) {
        this.db.exec('ALTER TABLE runs ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0')
      }
      if (!runColumns.has('output_tokens')) {
        this.db.exec('ALTER TABLE runs ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0')
      }
      if (!runColumns.has('cached_tokens')) {
        this.db.exec('ALTER TABLE runs ADD COLUMN cached_tokens INTEGER NOT NULL DEFAULT 0')
      }
      if (!runColumns.has('total_tokens')) {
        this.db.exec('ALTER TABLE runs ADD COLUMN total_tokens INTEGER NOT NULL DEFAULT 0')
      }
      if (!runColumns.has('cost_usd')) {
        this.db.exec('ALTER TABLE runs ADD COLUMN cost_usd REAL')
      }
      if (!runColumns.has('delivery_status')) {
        this.db.exec("ALTER TABLE runs ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'unavailable'")
      }
      for (const name of ['base_branch', 'branch_name', 'base_commit', 'head_commit', 'worktree_path', 'delivery_error']) {
        if (!runColumns.has(name)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${name} TEXT`)
      }
      for (const name of ['files_changed', 'additions', 'deletions']) {
        if (!runColumns.has(name)) {
          this.db.exec(`ALTER TABLE runs ADD COLUMN ${name} INTEGER NOT NULL DEFAULT 0`)
        }
      }

      const eventColumns = columns('run_events')
      if (!eventColumns.has('kind')) {
        this.db.exec("ALTER TABLE run_events ADD COLUMN kind TEXT NOT NULL DEFAULT 'output'")
      }
    })()

    this.rebuildRunsDeliveryConstraint()
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`)
  }

  private rebuildRunsDeliveryConstraint(): void {
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'runs'")
      .get() as { sql: string } | undefined
    if (row?.sql.includes("'reviewable'")) return

    this.db.pragma('foreign_keys = OFF')
    try {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE runs_next (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            agent_id TEXT NOT NULL,
            agent_label TEXT NOT NULL,
            model TEXT,
            prompt TEXT NOT NULL,
            title TEXT NOT NULL,
            cwd TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
            started_at INTEGER NOT NULL,
            ended_at INTEGER,
            exit_code INTEGER,
            error TEXT,
            input_tokens INTEGER NOT NULL DEFAULT 0,
            output_tokens INTEGER NOT NULL DEFAULT 0,
            cached_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            cost_usd REAL,
            delivery_status TEXT NOT NULL DEFAULT 'unavailable' CHECK (
              delivery_status IN (
                'preparing', 'working', 'finalizing', 'did_not_commit', 'reviewable', 'no_changes',
                'agent_failed', 'failed', 'unavailable'
              )
            ),
            base_branch TEXT,
            branch_name TEXT,
            base_commit TEXT,
            head_commit TEXT,
            worktree_path TEXT,
            files_changed INTEGER NOT NULL DEFAULT 0,
            additions INTEGER NOT NULL DEFAULT 0,
            deletions INTEGER NOT NULL DEFAULT 0,
            delivery_error TEXT
          );

          INSERT INTO runs_next (
            id, project_id, agent_id, agent_label, model, prompt, title, cwd,
            status, started_at, ended_at, exit_code, error,
            input_tokens, output_tokens, cached_tokens, total_tokens, cost_usd,
            delivery_status, base_branch, branch_name, base_commit, head_commit,
            worktree_path, files_changed, additions, deletions, delivery_error
          )
          SELECT
            id, project_id, agent_id, agent_label, model, prompt, title, cwd,
            status, started_at, ended_at, exit_code, error,
            input_tokens, output_tokens, cached_tokens, total_tokens, cost_usd,
            CASE WHEN delivery_status = 'ready' THEN 'reviewable' ELSE delivery_status END,
            base_branch, branch_name, base_commit, head_commit,
            worktree_path, files_changed, additions, deletions, delivery_error
          FROM runs;

          DROP TABLE runs;
          ALTER TABLE runs_next RENAME TO runs;
          CREATE INDEX runs_project_started_idx ON runs(project_id, started_at DESC);
        `)
      })()
    } finally {
      this.db.pragma('foreign_keys = ON')
    }

    const violations = this.db.pragma('foreign_key_check') as unknown[]
    if (violations.length > 0) throw new Error('Database migration produced foreign-key violations')
  }

  private seedSettings(): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)')
    this.db.transaction(() => {
      insert.run('defaultAgentId', DEFAULT_SETTINGS.defaultAgentId)
      insert.run('defaultModel', DEFAULT_SETTINGS.defaultModel)
    })()
  }

  private markInterruptedRunsFailed(): void {
    this.db
      .prepare(`
        UPDATE runs
        SET status = 'failed',
            delivery_status = 'agent_failed',
            error = 'Interrupted by app restart',
            delivery_error = 'The agent was interrupted before Git delivery completed.',
            ended_at = COALESCE(ended_at, ?)
        WHERE status = 'running'
      `)
      .run(Date.now())
  }

  getSettings(): Settings {
    const rows = this.db.prepare('SELECT key, value FROM settings').all() as Array<{
      key: keyof Settings
      value: string
    }>
    return rows.reduce<Settings>((settings, row) => {
      settings[row.key] = row.value
      return settings
    }, { ...DEFAULT_SETTINGS })
  }

  setSettings(next: Partial<Settings>): Settings {
    const upsert = this.db.prepare(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `)
    this.db.transaction(() => {
      if (next.defaultAgentId !== undefined) upsert.run('defaultAgentId', next.defaultAgentId)
      if (next.defaultModel !== undefined) upsert.run('defaultModel', next.defaultModel)
    })()
    return this.getSettings()
  }

  getProjects(): Project[] {
    const rows = this.db
      .prepare(`
        SELECT id, name, path, created_at, monthly_token_limit, monthly_cost_limit_usd,
               finish_on_push, git_platform
        FROM projects ORDER BY created_at ASC
      `)
      .all() as ProjectRow[]
    return rows.map(toProject)
  }

  addProject(project: Project): Project {
    this.db
      .prepare(`
        INSERT INTO projects (
          id, name, path, created_at, monthly_token_limit, monthly_cost_limit_usd,
          finish_on_push, git_platform
        ) VALUES (
          @id, @name, @path, @createdAt, @monthlyTokenLimit, @monthlyCostLimitUsd,
          @finishOnPush, @gitPlatform
        )
        ON CONFLICT(path) DO NOTHING
      `)
      .run(project)
    const row = this.db
      .prepare(`
        SELECT id, name, path, created_at, monthly_token_limit, monthly_cost_limit_usd,
               finish_on_push, git_platform
        FROM projects WHERE path = ?
      `)
      .get(project.path) as ProjectRow
    return toProject(row)
  }

  removeProject(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
  }

  updateProject(
    id: string,
    patch: Pick<Project, 'monthlyTokenLimit' | 'monthlyCostLimitUsd' | 'finishOnPush'>
  ): Project | undefined {
    this.db
      .prepare(`
        UPDATE projects
        SET monthly_token_limit = @monthlyTokenLimit,
            monthly_cost_limit_usd = @monthlyCostLimitUsd,
            finish_on_push = @finishOnPush
        WHERE id = @id
      `)
      .run({ id, ...patch })
    const row = this.db
      .prepare(`
        SELECT id, name, path, created_at, monthly_token_limit, monthly_cost_limit_usd,
               finish_on_push, git_platform
        FROM projects WHERE id = ?
      `)
      .get(id) as ProjectRow | undefined
    return row ? toProject(row) : undefined
  }

  getRuns(): Run[] {
    const rows = this.db
      .prepare(`
        SELECT id, project_id, agent_id, agent_label, model, prompt, title, cwd,
               status, started_at, ended_at, exit_code, error,
               input_tokens, output_tokens, cached_tokens, total_tokens, cost_usd,
               delivery_status, base_branch, branch_name, base_commit, head_commit,
               worktree_path, files_changed, additions, deletions, delivery_error
        FROM runs
        ORDER BY started_at DESC
      `)
      .all() as RunRow[]
    return rows.map(toRun)
  }

  addRun(run: Run): Run {
    this.db
      .prepare(`
        INSERT INTO runs (
          id, project_id, agent_id, agent_label, model, prompt, title, cwd,
          status, started_at, ended_at, exit_code, error,
          input_tokens, output_tokens, cached_tokens, total_tokens, cost_usd,
          delivery_status, base_branch, branch_name, base_commit, head_commit,
          worktree_path, files_changed, additions, deletions, delivery_error
        ) VALUES (
          @id, @projectId, @agentId, @agentLabel, @model, @prompt, @title, @cwd,
          @status, @startedAt, @endedAt, @exitCode, @error,
          @inputTokens, @outputTokens, @cachedTokens, @totalTokens, @costUsd,
          @deliveryStatus, @baseBranch, @branchName, @baseCommit, @headCommit,
          @worktreePath, @filesChanged, @additions, @deletions, @deliveryError
        )
      `)
      .run({
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
        deliveryError: run.deliveryError ?? null
      })
    return run
  }

  updateRun(id: string, patch: Partial<Run>): Run | undefined {
    const current = this.getRun(id)
    if (!current) return undefined
    const run = { ...current, ...patch }
    this.db
      .prepare(`
        UPDATE runs SET
          project_id = @projectId,
          agent_id = @agentId,
          agent_label = @agentLabel,
          model = @model,
          prompt = @prompt,
          title = @title,
          cwd = @cwd,
          status = @status,
          started_at = @startedAt,
          ended_at = @endedAt,
          exit_code = @exitCode,
          error = @error,
          input_tokens = @inputTokens,
          output_tokens = @outputTokens,
          cached_tokens = @cachedTokens,
          total_tokens = @totalTokens,
          cost_usd = @costUsd,
          delivery_status = @deliveryStatus,
          base_branch = @baseBranch,
          branch_name = @branchName,
          base_commit = @baseCommit,
          head_commit = @headCommit,
          worktree_path = @worktreePath,
          files_changed = @filesChanged,
          additions = @additions,
          deletions = @deletions,
          delivery_error = @deliveryError
        WHERE id = @id
      `)
      .run({
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
        deliveryError: run.deliveryError ?? null
      })
    return run
  }

  getRun(id: string): Run | undefined {
    const row = this.db
      .prepare(`
        SELECT id, project_id, agent_id, agent_label, model, prompt, title, cwd,
               status, started_at, ended_at, exit_code, error,
               input_tokens, output_tokens, cached_tokens, total_tokens, cost_usd,
               delivery_status, base_branch, branch_name, base_commit, head_commit,
               worktree_path, files_changed, additions, deletions, delivery_error
        FROM runs WHERE id = ?
      `)
      .get(id) as RunRow | undefined
    return row ? toRun(row) : undefined
  }

  appendEvent(event: RunEvent): void {
    this.db
      .prepare(`
        INSERT INTO run_events (id, run_id, ts, stream, kind, text)
        VALUES (@id, @runId, @ts, @stream, @kind, @text)
      `)
      .run(event)
  }

  readEvents(runId: string): RunEvent[] {
    const rows = this.db
      .prepare(`
        SELECT id, run_id, ts, stream, kind, text
        FROM run_events
        WHERE run_id = ?
        ORDER BY sequence ASC
      `)
      .all(runId) as RunEventRow[]
    return rows.map(toRunEvent)
  }

  close(): void {
    this.db.close()
  }
}
