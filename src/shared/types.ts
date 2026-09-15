import type { Issue, ParentIssue } from './valence'
import type { Keybindings } from './keybindings'
import type { ThinkingLevel } from './reasoning-levels'

export type { Issue } from './valence'

/** Live display data only; never persisted or used to expand execution scope. */
export interface TaskIssueSnapshot {
  parent: ParentIssue
  children: Issue[]
  execution?: Pick<TaskExecutionState, 'phase' | 'currentIssueId' | 'error'>
  reviewReady?: boolean
}

/** Anvil execution metadata only. Issue records belong to Valence. */
export interface TaskExecutionState {
  taskId: string
  projectPath: string
  style?: TaskStyle
  parentIssueId: string
  phase: 'planning' | 'working' | 'reviewing' | 'recovering' | 'complete' | 'blocked'
  issueIds: string[]
  currentIssueId: string | null
  error: string | null
  /** Original task settings, retained for subsequent turns and session follow-ups. */
  reasoningEffort?: string
  /** Originals are stored separately from task text for fresh-session recovery. */
  hasImages?: boolean
}

/** Encoded original image bytes, safe to send through Electron structured clone. */
export interface TaskImageAttachment {
  filename: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  bytes: Uint8Array
}

export interface WallpaperUpload {
  filename: string
  mimeType: TaskImageAttachment['mimeType']
  bytes: Uint8Array
}

export const TASK_IMAGE_LIMITS = {
  count: 8,
  perImageBytes: 10 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
  pixels: 16_000_000
} as const

export type TaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type TaskStyle = 'work' | 'quick'
export type TaskReviewPolicy = 'review_each_issue' | 'review_at_task_end'
export type TaskCheckoutMode = 'worktree' | 'local'

export type TaskResultNoticeKind = 'reviewable' | 'no_changes' | 'completed'

export interface TaskResultNotice {
  id: string
  workspaceId: string
  projectId: string
  taskId: string
  resultVersion: number
  kind: TaskResultNoticeKind
  headCommit?: string
  createdAt: number
  seenAt?: number
  dismissedAt?: number
}

export interface TaskResultNoticeChange {
  workspaceId: string
  projectId: string
  noticeId: string
  notice?: TaskResultNotice
}

export type DeliveryStatus =
  | 'preparing'
  | 'working'
  | 'finalizing'
  | 'did_not_commit'
  | 'reviewable'
  | 'merge_conflict'
  | 'approved'
  | 'no_changes'
  | 'agent_failed'
  | 'failed'
  | 'unavailable'

export interface Project {
  id: string
  name: string
  path: string
  createdAt: number
  monthlyTokenLimit: number | null
  monthlyCostLimitUsd: number | null
  finishOnPush: boolean
  gitPlatform: 'github'
}

/** A fresh, bounded snapshot for client-side fuzzy matching. No file contents. */
export interface ProjectFileList {
  projectId: string
  paths: string[]
  source: 'git' | 'directory' | null
  truncated: boolean
  warnings: ('unreadable' | 'git-unavailable')[]
  error: {
    code: 'project-not-found' | 'unavailable' | 'git-failed' | 'timeout' | 'busy'
    message: string
  } | null
}

export interface TaskMergePreview {
  sourceBranch: string
  targetBranch: string
  sourceCommit: string
  targetCommit: string
  commitCount: number
}

export interface TaskPushPreview {
  targetBranch: string
  targetCommit: string
  remote: 'origin'
  remoteTargetCommit: string | null
  /** Opaque identity used to reject a push when origin changes after preview. */
  remoteUrlHash: string
}

export interface TaskMergeAndPushPreview extends TaskMergePreview {
  remote: 'origin'
  remoteTargetCommit: string | null
  /** Opaque identity used to reject a push when origin changes after preview. */
  remoteUrlHash: string
}

export interface TaskMergeConflict {
  id: string
  taskId: string
  workspaceId: string
  projectId: string
  repositoryRoot: string
  sourceBranch: string
  targetBranch: string
  sourceCommit: string
  targetCommit: string
  mergeHeadCommit: string
  conflictedFiles: string[]
  requestedAction: 'merge' | 'merge_and_push'
  pushPreview?: TaskPushPreview
  createdAt: number
}

export const MERGE_CONFLICT_MAX_FILE_BYTES = 2 * 1024 * 1024

export type TaskMergeConflictFileStatus =
  | 'both_modified'
  | 'both_added'
  | 'both_deleted'
  | 'added_by_us'
  | 'added_by_them'
  | 'deleted_by_us'
  | 'deleted_by_them'
  | 'unsupported'

interface TaskMergeConflictFileBase {
  path: string
  status: TaskMergeConflictFileStatus
  stages: (1 | 2 | 3)[]
}

export type TaskMergeConflictFile = TaskMergeConflictFileBase & (
  | { support: 'text'; contents: string; contentsHash: string }
  | { support: 'unsupported'; reason: 'missing' | 'binary' | 'oversized' | 'symlink' | 'submodule' | 'other' | 'unsafe_path' | 'unsupported_status' }
)

export interface TaskMergeConflictSnapshot {
  id: string
  taskId: string
  sourceBranch: string
  targetBranch: string
  requestedAction: TaskMergeConflict['requestedAction']
  files: TaskMergeConflictFile[]
  canComplete: boolean
}

export interface PullRequestGitPreview extends TaskMergePreview {
  repository: string
  remote: 'origin'
  remoteTargetCommit: string
}

export interface PullRequestPreview extends PullRequestGitPreview {
  account: string
}

export interface PullRequestInfo {
  number: number
  url: string
  title: string
  description: string
  author: string
  sourceBranch: string
  targetBranch: string
  existing: boolean
}

export interface TaskPullRequest {
  number: number
  url: string
}

export type PullRequestField = 'title' | 'description'

export interface GitHubCredentialStatus {
  configured: boolean
}

export interface ProjectBranches {
  currentBranch: string | null
  branches: { name: string; checkedOut: boolean }[]
  worktreeBases?: { name: string; ref: string; remote: boolean }[]
  defaultWorktreeBase?: { name: string; ref: string; remote: boolean } | null
}

export interface ProjectGitStatus {
  /** True when the project folder resolves to a Git work tree. */
  isRepository: boolean
  /** Absolute path to the repository root, or null when there is none. */
  repoRoot: string | null
  /** False when the `git` binary could not be executed at all. */
  gitAvailable: boolean
  /** False when the project folder itself is gone (moved or deleted). */
  pathExists: boolean
}

/**
 * Where an agent's selectable models come from. `command` runs a CLI that
 * prints one model identifier per line. Adapters discover native capabilities.
 * `static` is a list for CLIs that cannot report their own.
 */
export type ModelSource =
  | { kind: 'adapter'; adapterId: string }
  | { kind: 'command'; command: string; args: string[] }
  | { kind: 'static'; models: string[] }

export interface ModelReasoningCapabilities {
  /** Opaque, model-scoped protocol values. Empty means no configurable reasoning. */
  options: Array<{ id: string; level: ThinkingLevel }>
  /** Only present when the provider advertises a default. */
  default?: string
}

export interface ProviderModelCapabilities {
  /** True only when the provider explicitly reports image input support. */
  imageInput: boolean
}

/**
 * The models one agent offers, spelled the way that agent's CLI expects them.
 * Deliberately generic: anything that can produce an array of strings — a
 * provider CLI, a hardcoded list, an API — fills this in the same way.
 */
export interface ProviderModelList {
  agentId: string
  models: string[]
  /** Missing entries mean discovery is unavailable, never an empty option list. */
  reasoningByModel?: Record<string, ModelReasoningCapabilities>
  /** Provider-reported input capabilities used by the server before dispatch. */
  capabilitiesByModel?: Record<string, ProviderModelCapabilities>
  /** Why the list came back empty; unset when the source succeeded. */
  error?: string
}

export interface AgentDefinition {
  id: string
  label: string
  description: string
  command: string
  args: string[]
  /**
   * Argument template for continuing an earlier session, with `{{session}}`
   * substituted. Omitted when the CLI cannot resume; the follow-up then runs
   * as a fresh session on the same task branch.
   */
  resumeArgs?: string[]
  defaultModel?: string
  /** How to enumerate this agent's models. Omitted when the CLI takes none. */
  models?: ModelSource
  /** Omitted for legacy CLI execution. OpenCode uses ACP; Codex uses its own server protocol. */
  executionProtocol?: 'acp' | 'codex-app-server'
  /** The adapter can inject user input into an active turn without restarting it. */
  supportsCompaction?: boolean
  supportsSteering?: boolean
  outputProtocol?: 'opencode-json' | 'codex-json'
}

export type StreamName = 'stdout' | 'stderr' | 'system'
export type TaskEventKind = 'output' | 'did_not_commit' | 'delivery'

/**
 * How a line is shown in the task output. Agent work is split into the kinds of
 * work the agent did; `system` is Anvil talking about itself (Git, spawning,
 * exit codes); `error` is everything the task wrote to stderr.
 */
export type TaskEventCategory =
  | 'message'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'system'
  | 'error'

export const TASK_EVENT_CATEGORIES: TaskEventCategory[] = [
  'message',
  'thinking',
  'tool_use',
  'tool_result',
  'system',
  'error'
]

export interface TaskEvent {
  /** Persisted insertion order, supplied on history pages and live IPC output. */
  sequence?: number
  /** Stable for tool snapshots: a repeated ID replaces the previous event in place. */
  id: string
  taskId: string
  /** Owning Valence issue captured at turn start; absent for task-level and legacy output. */
  issueId?: string
  ts: number
  stream: StreamName
  kind: TaskEventKind
  category: TaskEventCategory
  /** tool_use: first line is the name, remaining lines describe what was executed. */
  text: string
}

export const DEFAULT_TASK_EVENT_PAGE_SIZE = 500
export const MAX_TASK_EVENT_PAGE_SIZE = 4_000

/** Insertion position within one task; timestamps and snapshot updates do not move it. */
export interface TaskEventCursor {
  taskId: string
  sequence: number
}

export interface TaskEventsRequest {
  taskId: string
  limit?: number
  /** Exclusive bounds. Omit both to return to the latest page. */
  before?: TaskEventCursor
  after?: TaskEventCursor
}

export interface TaskEventsPage {
  /** Always chronological by insertion sequence, including on backward reads. */
  events: (TaskEvent & { sequence: number })[]
  oldestCursor: TaskEventCursor | null
  newestCursor: TaskEventCursor | null
  hasOlder: boolean
  hasNewer: boolean
}

export const DEFAULT_WORKSPACE_ID = 'default'
export const MAX_WORKSPACE_NAME_LENGTH = 80

export interface Workspace {
  id: string
  name: string
  createdAt: number
}

export interface ComposerPreferences {
  agentId: string
  modelsByAgent: Record<string, string>
  reasoningByAgentModel: Record<string, string>
  reviewPolicy?: TaskReviewPolicy
}

export interface WorkspaceSnapshot {
  workspaces: Workspace[]
  workspace: Workspace
  settings: Settings
  preferences: WorkspacePreferences
  projects: Project[]
  tasks: Task[]
  taskResultNotices: TaskResultNotice[]
}

export interface WorkspaceSettingsChange {
  workspaceId: string
  settings: Settings
}

export type HeadlessAccessMode = 'local' | 'lan' | 'tailscale'

export interface ConnectionsStatus {
  headlessAccess?: HeadlessAccessMode
  tailscaleHttps: boolean
  tailscaleUrl?: string
  tailscaleSetupUrl?: string
  allowOtherDevices: boolean
  passwordConfigured: boolean
  pending: boolean
  error?: string
}

export interface ConnectionsConfigure {
  workspaceId: string
  allowOtherDevices: boolean
  password?: string
  tailscaleHttps?: boolean
}

export interface ConnectionsStatusChange {
  workspaceId: string
  status: ConnectionsStatus
}

export interface WorkspacePreferences {
  composer: ComposerPreferences
  lastProjectId: string | null
}

export interface TaskStackTarget {
  commit: string
  branch: string
  parentTaskId?: string
  oldBase?: string
}

export interface Task {
  style?: TaskStyle
  reviewPolicy?: TaskReviewPolicy
  checkoutMode?: TaskCheckoutMode
  startBase?: string
  parentTaskId?: string
  expectedFiles?: string[]
  restackState?: 'pending' | 'conflict'
  restackTarget?: TaskStackTarget
  stackSuggestion?: { parentTaskId: string; paths: string[] }

  id: string
  readonly workspaceId: string
  projectId: string
  agentId: string
  agentLabel: string
  model?: string
  prompt: string
  title: string
  cwd: string
  status: TaskStatus
  startedAt: number
  endedAt?: number
  /** Measured working milliseconds through the last checkpoint. Legacy records start at zero. */
  workingTimeMs?: number
  /** Open working interval, absent while paused. Recovery discards uncheckpointed intervals. */
  workingStartedAt?: number
  reviewedAt?: number
  settledAt?: number
  exitCode?: number | null
  error?: string
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  totalTokens: number
  costUsd: number | null
  deliveryStatus: DeliveryStatus
  mergeConflict?: TaskMergeConflict
  baseBranch?: string
  branchName?: string
  baseCommit?: string
  headCommit?: string
  /** Current PR for this task's reviewable head revision. Derived from persisted link metadata. */
  pullRequest?: TaskPullRequest
  filesChanged: number
  additions: number
  deletions: number
  deliveryError?: string
  contextUsed?: number | null
  contextSize?: number | null
  contextCompactionError?: string | null
  contextCompacting?: boolean
  /** Agent session to resume, so review follow-ups keep the original context. */
  sessionId?: string
}

/** A review note the developer left on a line of a task's diff. */
export interface TaskComment {
  id: string
  taskId: string
  /** Path of the file in the diff, as the patch names it. */
  file: string
  /** Which side of the diff the line belongs to. */
  side: 'additions' | 'deletions'
  lineNumber: number
  body: string
  createdAt: number
  /** Null while the note is still a draft; set when it was sent to the agent. */
  sentAt: number | null
}

export interface TaskCommit {
  sha: string
  subject: string
}

export interface TaskDiff {
  patch: string
  commits: TaskCommit[]
}

export type TaskUsage = Pick<
  Task,
  'inputTokens' | 'outputTokens' | 'cachedTokens' | 'totalTokens' | 'costUsd'
>

export interface AnalyticsRange {
  startAt: number
  endAt: number
}

export interface AnalyticsTokenTotals {
  input: number
  output: number
  cached: number
  total: number
}

export interface AnalyticsCostTotals {
  reportedUsd: number
  reportedTaskCount: number
  unreportedTaskCount: number
}

export interface AnalyticsTaskTotals {
  total: number
  completed: number
  successful: number
  successRate: number | null
  statusCounts: Record<TaskStatus, number>
}

export interface AnalyticsFavorite {
  key: string
  label: string
  taskCount: number
}

export interface AnalyticsTimingTotals {
  workingTimeMs: number
  averageWorkingTimeMs: number
}

export interface AnalyticsCodeChangeTotals {
  filesChanged: number
  additions: number
  deletions: number
}

export interface AnalyticsBreakdown {
  key: string
  label: string
  taskCount: number
  totalTokens: number
  reportedCostUsd: number
}

export interface WorkspaceAnalytics {
  range: AnalyticsRange
  tokens: AnalyticsTokenTotals
  cost: AnalyticsCostTotals
  tasks: AnalyticsTaskTotals
  favoriteModel: AnalyticsFavorite | null
  favoriteProvider: AnalyticsFavorite | null
  timing: AnalyticsTimingTotals
  codeChanges: AnalyticsCodeChangeTotals
  breakdowns: {
    providers: AnalyticsBreakdown[]
    models: AnalyticsBreakdown[]
    statuses: AnalyticsBreakdown[]
    projects: AnalyticsBreakdown[]
  }
}

/**
 * Who rewrites a task's commits. `manual` opens a small interactive-rebase
 * editor and Anvil performs the rebase itself; `agent` hands the job to the
 * agent that wrote the code and accepts whatever it produces.
 */
export type RebaseMode = 'manual' | 'agent'

/** What to do with one commit, spelled the way `git rebase -i` spells it. */
export type RebaseAction = 'pick' | 'squash' | 'drop'

export interface RebaseStep {
  sha: string
  action: RebaseAction
  /** The resulting commit's message. Only read for a `pick`. */
  message: string
}

export interface Wallpaper {
  id: string
  name: string
  width: number
  height: number
}

export interface Settings {
  autoCompactContext?: boolean
  contextCompactionThreshold?: number
  memoryEnabled: boolean
  memoryEmbeddingModel: string
  ollamaBaseUrl: string
  fontSize: number
  overviewBackgroundMode: 'color' | 'image'
  overviewBackgroundColor: string
  overviewWallpaperId: string | null
  defaultAgentId: string
  defaultModel: string
  rebaseMode: RebaseMode
  /** Whether handing a rebase to the agent asks for confirmation first. */
  confirmRebase: boolean
  /** Keep the system and display awake while tasks are running. */
  caffeineMode: boolean
  /** Allow authenticated HTTP clients on other devices to reach the server. */
  allowOtherDevices: boolean
  /** Serve Anvil over HTTPS within the connected Tailscale network. */
  tailscaleHttps: boolean
  /** Accelerator per shortcut, e.g. `{ toggleSidebar: 'Mod+B' }`. */
  keybindings: Keybindings
}

export interface AgentAccountTarget {
  workspaceId: string
  agentId: 'codex' | 'opencode'
}

export interface AgentAccountConnect extends AgentAccountTarget {
  method: 'apiKey' | 'chatgpt' | 'deviceAuth' | 'native'
  apiKey?: string
}

export interface WorkspaceAgentAccount extends AgentAccountTarget {
  terminalSessionId?: string
  workspaceName: string
  status: 'signed-out' | 'connected' | 'pending' | 'cancelled' | 'busy' | 'error'
  accounts: string[]
  busy: boolean
  message?: string
  sessionId?: string
}
