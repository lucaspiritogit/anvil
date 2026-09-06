import type { AgentExecutor } from './agent-executor'

export type { TaskInput, TaskEvent, TaskResult } from './agent-executor'

/** Anvil adapter for agents speaking the Agent Client Protocol, currently OpenCode. */
export interface AgentClientProtocol extends AgentExecutor {}
