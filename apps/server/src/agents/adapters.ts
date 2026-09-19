import type { WorkspaceExecutionContext } from './workspace-execution'
import type { AgentDefinition, ProviderModelList } from '@anvil/protocol/types'
import type { AgentExecutor } from './agent-executor'
import { CodexAppServerClient } from './codex-app-server'
import { OpenCodeAcpClient } from './opencode-acp'
import { discoverOpenCodeModels } from './opencode-sdk'
import { isWorkspaceOpenCodeModel } from './opencode-workspace'

export type AgentModelCatalogue = Pick<ProviderModelList, 'models' | 'reasoningByModel' | 'capabilitiesByModel'>

/** Provider discovery and execution share one registration point. */
export interface AgentAdapter {
  id: string
  createExecutor(workspace: WorkspaceExecutionContext, catalogue?: () => Promise<ProviderModelList>): AgentExecutor
  listModels(agent: AgentDefinition, workspace: WorkspaceExecutionContext, signal?: AbortSignal): Promise<AgentModelCatalogue>
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
  createExecutor: (workspace, catalogue) => new OpenCodeAcpClient({ workspace, catalogue }),
  async listModels(agent, workspace, signal) {
    const discovered = await discoverOpenCodeModels(agent, workspace, signal)
    const models = discovered.models.filter(isWorkspaceOpenCodeModel)
    const included = new Set(models)
    const reasoningByModel = Object.fromEntries(
      Object.entries(discovered.reasoningByModel ?? {}).filter(([model]) => included.has(model))
    )
    const capabilitiesByModel = Object.fromEntries(
      Object.entries(discovered.capabilitiesByModel ?? {}).filter(([model]) => included.has(model))
    )
    return { models, reasoningByModel, capabilitiesByModel }
  }
}

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  createExecutor: (workspace, catalogue) => new CodexAppServerClient({ workspace }, catalogue),
  async listModels(agent, workspace, signal) {
    const client = new CodexAppServerClient({ command: agent.command, args: agent.args, requestTimeoutMs: 20_000, workspace })
    const cancel = (): void => { void client.close() }
    signal?.addEventListener('abort', cancel, { once: true })
    try {
      signal?.throwIfAborted()
      return await client.listModels(workspace.home)
    } finally {
      signal?.removeEventListener('abort', cancel)
      await client.close()
    }
  }
}

const registry = new AgentAdapterRegistry()
registry.register(openCodeAdapter)
registry.register(codexAdapter)
export const registerAgentAdapter = (adapter: AgentAdapter): void => registry.register(adapter)
export const getAgentAdapter = (id: string): AgentAdapter => registry.get(id)
