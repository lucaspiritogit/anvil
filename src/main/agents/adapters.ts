import type { AgentDefinition, ProviderModelList } from '../../shared/types'
import type { AgentExecutor } from './agent-executor'
import { CodexAppServerClient } from './codex-app-server'
import { OpenCodeAcpClient } from './opencode-acp'
import { parseOpenCodeModels } from './opencode-models'
import { readOpenCodeModelOutput } from './opencode-model-output'

export type AgentModelCatalogue = Pick<ProviderModelList, 'models' | 'reasoningByModel'>

/** Provider discovery and execution share one registration point. */
export interface AgentAdapter {
  id: string
  createExecutor(): AgentExecutor
  listModels(agent: AgentDefinition): Promise<AgentModelCatalogue>
}

export class AgentAdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>()

  register(adapter: AgentAdapter): void {
    if (this.adapters.has(adapter.id)) throw new Error(`Agent adapter already registered: ${adapter.id}`)
    this.adapters.set(adapter.id, adapter)
  }

  get(id: string): AgentAdapter {
    const adapter = this.adapters.get(id)
    if (!adapter) throw new Error(`Unknown agent adapter: ${id}`)
    return adapter
  }
}

export const openCodeAdapter: AgentAdapter = {
  id: 'opencode',
  createExecutor: () => new OpenCodeAcpClient(),
  async listModels(agent) {
    const stdout = await readOpenCodeModelOutput(agent.command, ['models', '--verbose'])
    return parseOpenCodeModels(stdout)
  }
}

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  createExecutor: () => new CodexAppServerClient(),
  async listModels(agent) {
    const client = new CodexAppServerClient({ command: agent.command, args: agent.args, requestTimeoutMs: 20_000 })
    try {
      return await client.listModels(process.cwd())
    } finally {
      await client.close()
    }
  }
}

const registry = new AgentAdapterRegistry()
registry.register(openCodeAdapter)
registry.register(codexAdapter)
export const registerAgentAdapter = (adapter: AgentAdapter): void => registry.register(adapter)
export const getAgentAdapter = (id: string): AgentAdapter => registry.get(id)
