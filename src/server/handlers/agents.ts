import type { Store } from '../store'
import { resolveWorkspaceExecution } from '../agents/workspace-execution'
import type { HandlerRegistry } from '../handler-registry'
import { listModels } from '../agents/models'
import { BUILTIN_AGENTS, getAgent } from '../agents/registry'
import type { ProviderModelList } from '../../shared/types'

export function registerAgentHandlers(ipc: HandlerRegistry, store: Store): void {
  ipc.handle('agents:list', () => BUILTIN_AGENTS)

  ipc.handle('agents:models', ({ agentId, workspaceId }): Promise<ProviderModelList> => {
    const agent = getAgent(agentId)
    if (!agent) throw new Error(`Unknown agent: ${agentId}`)
    return listModels(agent, resolveWorkspaceExecution(store, workspaceId ?? store.getActiveWorkspace().id))
  })
}
