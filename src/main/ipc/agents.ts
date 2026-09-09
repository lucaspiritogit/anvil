import type { RendererIpc } from '../renderer-security'
import { listModels } from '../agents/models'
import { BUILTIN_AGENTS, getAgent } from '../agents/registry'
import type { ProviderModelList } from '../../shared/types'

export function registerAgentHandlers(ipc: RendererIpc): void {
  ipc.handle('agents:list', () => BUILTIN_AGENTS)

  ipc.handle('agents:models', (_event, agentId: string): Promise<ProviderModelList> => {
    const agent = getAgent(agentId)
    if (!agent) throw new Error(`Unknown agent: ${agentId}`)
    return listModels(agent)
  })
}
