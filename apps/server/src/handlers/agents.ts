import type { Store } from '../store'
import { resolveWorkspaceExecution } from '../agents/workspace-execution'
import type { HandlerRegistry } from '../handler-registry'
import { listModels } from '../agents/models'
import { BUILTIN_AGENTS, getAgent } from '../agents/registry'
import type { ProviderModelList } from '@anvil/protocol/types'
import type { AgentUpdates } from '../agents/agent-updates'

export function registerAgentHandlers(ipc: HandlerRegistry, store: Store, updates: AgentUpdates): void {
  ipc.handle('agents:update-state', () => updates.state())
  ipc.handle('agents:update-check', (input) => updates.check(input?.force === true))
  ipc.handle('agents:update-install', ({ agentId }) => updates.install(agentId))

  ipc.handle('agents:list', () => BUILTIN_AGENTS)

  ipc.handle('agents:models', ({ agentId, workspaceId }): Promise<ProviderModelList> => {
    const agent = getAgent(agentId)
    if (!agent) throw new Error(`Unknown agent: ${agentId}`)
    return listModels(agent, resolveWorkspaceExecution(store, workspaceId ?? store.getActiveWorkspace().id))
  })
}
