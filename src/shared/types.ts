import type { Issue, ParentIssue } from './valence'
import type { Keybindings } from './keybindings'

export type { Issue } from './valence'

/** Live display data only; never persisted or used to expand execution scope. */
export interface TaskIssueSnapshot {
  parent: ParentIssue
  children: Issue[]
}

/** Anvil execution metadata only. Issue records belong to Valence. */
export interface TaskExecutionState {
  taskId: string
  projectPath: string
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

export const TASK_IMAGE_LIMITS = {
  count: 8,
  perImageBytes: 10 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
  pixels: 16_000_000
} as const

export type TaskStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export type DeliveryStatus =
  | 'preparing'
  | 'working'
  | 'finalizing'
  | 'did_not_commit'
  | 'reviewable'
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

export type PullRequestField = 'title' | 'description'

export interface GitHubCredentialStatus {
  configured: boolean
}

export interface ProjectBranches {
  currentBranch: string | null
  branches: { name: string; checkedOut: boolean }[]
}

export interface TerminalSnapshot {
  data: string
  sequence: number
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
  options: Array<{ id: string; label: string }>
  /** Only present when the provider advertises a default. */
  default?: string
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
}

export interface WorkspacePreferences {
  composer: ComposerPreferences
  lastProjectId: string | null
}

export interface Task {
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
  baseBranch?: string
  branchName?: string
  baseCommit?: string
  headCommit?: string
  filesChanged: number
  additions: number
  deletions: number
  deliveryError?: string
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
  /** Accelerator per shortcut, e.g. `{ toggleSidebar: 'Mod+B' }`. */
  keybindings: Keybindings
}
