import type { Keybindings } from './keybindings'

export type { Issue } from 'valence'

/** Anvil execution metadata only. Issue records belong to Valence. */
export interface TaskExecutionState {
  taskId: string
  projectPath: string
  phase: 'planning' | 'working' | 'recovering' | 'complete' | 'blocked'
  issueIds: string[]
  currentIssueId: string | null
  error: string | null
  /** Original task settings, retained for subsequent turns and session follow-ups. */
  thinkingLevel?: ThinkingLevel
  modelEffort?: string
}

export type TaskStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'

/** Canonical reasoning-effort levels sent to agent processes. */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high' | 'xhigh'

/** Renderer-facing labels for the composer thinking selector, index-aligned with levels. */
export const THINKING_LEVEL_LABELS: readonly string[] = ['Off', 'Low', 'Medium', 'High', 'Extra high']
export const THINKING_LEVEL_VALUES: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high', 'xhigh']

/** Maps a renderer label ('Off'...'Extra high') to a canonical level; unknown labels fall back to 'medium'. */
export function thinkingLevelFromLabel(label: string): ThinkingLevel {
  const index = THINKING_LEVEL_LABELS.indexOf(label)
  return index >= 0 ? THINKING_LEVEL_VALUES[index]! : 'medium'
}
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
 * prints one model identifier per line, or OpenCode's verbose metadata when
 * requested by `format`. `static` is a list for CLIs that cannot report their own.
 */
export type ModelSource =
  | { kind: 'command'; command: string; args: string[]; format?: 'opencode-verbose' }
  | { kind: 'static'; models: string[] }

/**
 * The models one agent offers, spelled the way that agent's CLI expects them.
 * Deliberately generic: anything that can produce an array of strings — a
 * provider CLI, a hardcoded list, an API — fills this in the same way.
 */
export interface ProviderModelList {
  agentId: string
  models: string[]
  /** Native effort IDs advertised by each model. An empty list means no selector. */
  effortsByModel?: Record<string, string[]>
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
   * as a fresh session against the same worktree.
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
  ts: number
  stream: StreamName
  kind: TaskEventKind
  category: TaskEventCategory
  /** tool_use: first line is the name, remaining lines describe what was executed. */
  text: string
}

export interface Task {
  id: string
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
  worktreePath?: string
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

export interface Settings {
  defaultAgentId: string
  defaultModel: string
  rebaseMode: RebaseMode
  /** Whether handing a rebase to the agent asks for confirmation first. */
  confirmRebase: boolean
  /** Accelerator per shortcut, e.g. `{ toggleSidebar: 'Mod+B' }`. */
  keybindings: Keybindings
}
