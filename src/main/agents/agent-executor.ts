import type { TaskEvent as OutputTaskEvent, TaskStatus, TaskUsage, ThinkingLevel } from '../../shared/types'

/** One Anvil agent turn. Issue persistence and validation belong to Valence. */
export interface TaskInput {
  taskId: string
  issueId?: string
  prompt: string
  /** Absolute project or task worktree path. */
  cwd: string
  /** Original project owning the Valence tracker, distinct from the worktree. */
  projectPath?: string
  model?: string
  /** Requested reasoning-effort level; adapters translate it to their wire protocol. */
  thinkingLevel?: ThinkingLevel
  /** Native model-specific effort ID, checked against ACP options before use. */
  modelEffort?: string
  resumeSessionId?: string
  signal?: AbortSignal
}

/** Transport-independent events consumed by Anvil's output and persistence system. */
export type TaskEvent =
  | { type: 'output'; event: OutputTaskEvent }
  | { type: 'session'; taskId: string; sessionId: string }
  | { type: 'usage'; taskId: string; usage: TaskUsage }

export interface TaskResult {
  taskId: string
  issueId?: string
  status: Exclude<TaskStatus, 'running'>
  sessionId?: string
  /** Only this turn's assistant text, never replayed history or tool output. */
  output: string
  /** Paths reported by completed mutating tools. Git delivery remains authoritative. */
  changedFiles: string[]
  /** This execution's usage, when the agent supplies it. */
  usage?: TaskUsage
  stopReason?: string
  error?: string
}

export interface TaskSteeringInput {
  taskId: string
  /** Must match the active execution, never an older task session. */
  sessionId: string
  message: string
}

/** Anvil's execution interface, independent of an agent's wire protocol. */
export interface AgentExecutor {
  /**
   * Runs one turn and emits normalized events before resolving. Operational failures
   * and cancellation return a result; no database or renderer dependencies belong here.
   */
  execute(input: TaskInput, onEvent: (event: TaskEvent) => void): Promise<TaskResult>
  /** Injects input into an active turn. Omitted for agents without live steering. */
  steer?(input: TaskSteeringInput): Promise<void>
  /** Permanently stops this executor and waits for its server and tools to exit. */
  close?(): Promise<void>
}
