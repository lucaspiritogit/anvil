import type { AgentProcessManager } from '../agents/process-manager'
import type { GitDeliveryManager } from '../git'
import type { Store } from '../store'
import type { TaskEventCategory, TaskEventKind } from '@anvil/protocol/types'

export type PublishEvent = (channel: string, payload: unknown) => void

export type RecordSystemEvent = (
  taskId: string,
  text: string,
  kind?: TaskEventKind,
  category?: TaskEventCategory
) => void

export interface TaskContext {
  store: Store
  agentProcesses: AgentProcessManager
  gitDelivery: GitDeliveryManager
  send: PublishEvent
}
