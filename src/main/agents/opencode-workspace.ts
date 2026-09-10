import { existsSync, readdirSync } from 'node:fs'
import { userInfo } from 'node:os'
import { dirname, join, parse } from 'node:path'
import type { WorkspaceExecutionContext } from './workspace-execution'

// Verified against the tagged source and temporary-profile CLI probes. In this
// release port 0 tries 4096, then binds an OS-assigned port if it is occupied.
// The child owns the socket throughout its lifetime; there is no check/bind gap
// or parent-side reservation to leak on cancellation or process failure.
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
  requireOpenCodeProjectIsolation(workspace.home)
  return { command: 'opencode', args, cwd: workspace.home, environment: openCodeWorkspaceEnvironment(workspace) }
}

/** Fail before OpenCode loads project settings, without reading secret values.
 * AGENTS.md and other ordinary repository instructions remain discoverable.
 * Provider settings belong in the workspace's XDG config, never in a project
 * shared by Work and Personal. Reject dotenv files too: CLI runtimes may load
 * these before OpenCode's own config flags take effect.
 */
export function requireOpenCodeProjectIsolation(cwd: string): void {
  let directory = cwd
  while (true) {
    const names = readdirSync(directory)
    const unsafe = names.find((name) => {
      if (name === 'opencode.json' || name === 'opencode.jsonc') return true
      if (['.env.example', '.env.sample', '.env.template'].includes(name)) return false
      return name === '.env' || name.startsWith('.env.')
    })
    const nestedConfig = ['opencode.json', 'opencode.jsonc'].find((name) => existsSync(join(directory, '.opencode', name)))
    if (unsafe || nestedConfig) {
      const path = unsafe ? join(directory, unsafe) : join(directory, '.opencode', nestedConfig!)
      throw new Error(`OpenCode workspace isolation cannot be guaranteed with project configuration at ${path}. Move account configuration to this workspace's config/opencode/opencode.json and credentials to its data/opencode/auth.json. Remove project dotenv/config overrides before retrying. Repository AGENTS.md instructions remain supported.`)
    }
    if (names.includes('.git') || directory === parse(directory).root) break
    directory = dirname(directory)
  }
  // Managed configuration is deliberately outside XDG/HOME on all platforms.
  // Do not override administrator policy with OpenCode's test-only switches.
  const managed = process.platform === 'darwin' ? [
    '/Library/Application Support/opencode',
    '/Library/Managed Preferences/ai.opencode.managed.plist',
    join('/Library/Managed Preferences', userInfo().username, 'ai.opencode.managed.plist')
  ] : process.platform === 'win32' ? [join(process.env.ProgramData ?? 'C:\\ProgramData', 'opencode')] : ['/etc/opencode']
  if (managed.some((path) => existsSync(path))) {
    throw new Error('OpenCode workspace isolation cannot be guaranteed while system managed OpenCode configuration is installed. Ask your administrator to provide a workspace-compatible configuration.')
  }
}
