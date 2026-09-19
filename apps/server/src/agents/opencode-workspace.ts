import type { WorkspaceExecutionContext } from './workspace-execution'

export const OPEN_CODE_ACP_ARGS = ['acp', '--port', '0', '--hostname', '127.0.0.1', '--mdns=false']
const SUPPORTED_PROVIDERS = new Set(['openai', 'anthropic', 'openrouter', 'opencode', 'opencode-go'])

export function isWorkspaceOpenCodeModel(model: string): boolean {
  return SUPPORTED_PROVIDERS.has(model.split('/')[0])
}

export function requireWorkspaceOpenCodeModel(model: string | undefined): void {
  if (!model || !isWorkspaceOpenCodeModel(model)) {
    throw new Error('Select an OpenAI, Anthropic, OpenRouter or OpenCode model for this workspace. Other provider credential chains have not been verified for workspace isolation.')
  }
}

export function openCodeWorkspaceEnvironment(workspace: WorkspaceExecutionContext): NodeJS.ProcessEnv {
  return {
    ...workspace.environment,
    OPENCODE_PURE: 'true',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({
      enabled_providers: [...SUPPORTED_PROVIDERS],
      permission: { external_directory: 'allow' }
    })
  }
}

/** Shared launch descriptor for discovery and interactive auth login/logout/status. */
export function openCodeWorkspaceCommand(workspace: WorkspaceExecutionContext, args: string[]): {
  command: string
  args: string[]
  cwd: string
  environment: NodeJS.ProcessEnv
} {
  return { command: 'opencode', args, cwd: workspace.home, environment: openCodeWorkspaceEnvironment(workspace) }
}
