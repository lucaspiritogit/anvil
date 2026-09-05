import type { Keybindings } from './keybindings'

export interface Issue {
  id: string
  title: string
  description: string
  checklist: string[]
  validation: string
  labels: string[]
  priority: 'urgent' | 'high' | 'medium' | 'low'
  dependencies: string[]
  status: 'queued' | 'working' | 'blocked' | 'complete'
  evidence?: string
  completedAt?: number
}
export interface IssueTracker {
  runId: string
  limit: 50
  phase: 'planning' | 'working' | 'complete' | 'blocked'
  items: Issue[]
  error: string | null
  eventOffset: number
}

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'
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
 * prints one model identifier per line; `static` is a list Anvil ships for
 * CLIs that cannot report their own.
 */
export type ModelSource =
  | { kind: 'command'; command: string; args: string[] }
  | { kind: 'static'; models: string[] }

/**
 * The models one agent offers, spelled the way that agent's CLI expects them.
 * Deliberately generic: anything that can produce an array of strings — a
 * provider CLI, a hardcoded list, an API — fills this in the same way.
 */
export interface ProviderModelList {
  agentId: string
  models: string[]
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
  outputProtocol?: 'opencode-json' | 'codex-json' | 'pi-json'
}

export type StreamName = 'stdout' | 'stderr' | 'system'
export type RunEventKind = 'output' | 'did_not_commit' | 'delivery'

/**
 * How a line is shown in the run output. Agent work is split into the kinds of
 * work the agent did; `system` is Anvil talking about itself (Git, spawning,
 * exit codes); `error` is everything the task wrote to stderr.
 */
export type RunEventCategory =
  | 'message'
  | 'thinking'
  | 'tool_use'
  | 'tool_result'
  | 'system'
  | 'error'

export const RUN_EVENT_CATEGORIES: RunEventCategory[] = [
  'message',
  'thinking',
  'tool_use',
  'tool_result',
  'system',
  'error'
]

export interface RunEvent {
  id: string
  runId: string
  ts: number
  stream: StreamName
  kind: RunEventKind
  category: RunEventCategory
  text: string
}

export interface Run {
  id: string
  projectId: string
  agentId: string
  agentLabel: string
  model?: string
  prompt: string
  title: string
  cwd: string
  status: RunStatus
  startedAt: number
  endedAt?: number
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
export interface RunComment {
  id: string
  runId: string
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

export interface RunCommit {
  sha: string
  subject: string
}

export interface RunDiff {
  patch: string
  commits: RunCommit[]
}

export type RunUsage = Pick<
  Run,
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
