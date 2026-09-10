import type { WorkspaceExecutionContext } from './workspace-execution'
import type { AgentDefinition, ProviderModelList } from '../../shared/types'
import type { AgentExecutor } from './agent-executor'
import { CodexAppServerClient } from './codex-app-server'
import { OpenCodeAcpClient } from './opencode-acp'
import { parseOpenCodeModels } from './opencode-models'
import { readOpenCodeModelOutput, verifyWorkspaceOpenCode } from './opencode-model-output'
import { isWorkspaceOpenCodeModel, openCodeWorkspaceCommand } from './opencode-workspace'

export type AgentModelCatalogue = Pick<ProviderModelList, 'models' | 'reasoningByModel'>

/** Provider discovery and execution share one registration point. */
export interface AgentAdapter {
  id: string
  createExecutor(workspace: WorkspaceExecutionContext): AgentExecutor
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
  createExecutor: (workspace) => new OpenCodeAcpClient({ workspace }),
  async listModels(agent, workspace, signal) {
    const launch = openCodeWorkspaceCommand(workspace, ['models', '--refresh', '--verbose'])
    await verifyWorkspaceOpenCode(agent.command, launch.cwd, launch.environment, signal)
    const stdout = await readOpenCodeModelOutput(agent.command, launch.args, launch.cwd, signal, launch.environment)
    const catalogue = parseOpenCodeModels(stdout)
    catalogue.models = catalogue.models.filter(isWorkspaceOpenCodeModel)
    catalogue.reasoningByModel = Object.fromEntries(Object.entries(catalogue.reasoningByModel ?? {}).filter(([model]) => isWorkspaceOpenCodeModel(model)))
    return catalogue
  }
}

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  createExecutor: (workspace) => new CodexAppServerClient({ workspace }),
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
