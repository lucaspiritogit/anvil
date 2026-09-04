export type RunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled'
export type DeliveryStatus =
  | 'preparing'
  | 'working'
  | 'finalizing'
  | 'did_not_commit'
  | 'reviewable'
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

export interface AgentDefinition {
  id: string
  label: string
  description: string
  command: string
  args: string[]
  defaultModel?: string
  outputProtocol?: 'opencode-json' | 'claude-json' | 'codex-json' | 'pi-json'
}

export type StreamName = 'stdout' | 'stderr' | 'system'
export type RunEventKind = 'output' | 'did_not_commit' | 'delivery'

export interface RunEvent {
  id: string
  runId: string
  ts: number
  stream: StreamName
  kind: RunEventKind
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

export interface Settings {
  defaultAgentId: string
  defaultModel: string
}
