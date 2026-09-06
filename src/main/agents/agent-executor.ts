import type { TaskEvent as OutputTaskEvent, TaskStatus, TaskUsage } from '../../shared/types'

/** One Anvil agent turn. Issue persistence and validation belong to Valence. */
export interface TaskInput {
  taskId: string
  issueId?: string
  prompt: string
  /** Absolute project or task worktree path. */
  cwd: string
  model?: string
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

/** Anvil's execution interface, independent of an agent's wire protocol. */
export interface AgentExecutor {
  /**
   * Runs one turn and emits normalized events before resolving. Operational failures
   * and cancellation return a result; no database or renderer dependencies belong here.
   */
  execute(input: TaskInput, onEvent: (event: TaskEvent) => void): Promise<TaskResult>
}
