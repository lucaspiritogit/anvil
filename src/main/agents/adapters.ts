import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentDefinition, ProviderModelList } from '../../shared/types'
import type { AgentExecutor } from './agent-executor'
import { CodexAppServerClient } from './codex-app-server'
import { OpenCodeAcpClient } from './opencode-acp'
import { parseOpenCodeModels } from './opencode-models'
import { resolveCommand } from './resolve'

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
    const resolved = resolveCommand(agent.command)
    if (!resolved) throw new Error(`"${agent.command}" is not installed or not on PATH`)
    const { stdout } = await promisify(execFile)(resolved.command, [...resolved.prefixArgs, 'models', '--verbose'], {
      timeout: 20_000, maxBuffer: 32 * 1024 * 1024,
      shell: resolved.viaShell, windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
    })
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
