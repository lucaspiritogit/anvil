import type { AgentDefinition } from '../../shared/types'

/**
 * Git guidance given to every agent on a task in a Git repository. Anvil does
 * not drive Git on the agent's behalf: the agent commits its own work with its
 * own message, the way a developer would.
 */
export const GIT_SYSTEM_PROMPT = [
  'Use Git normally as you work, and commit your own changes with a clear message.',
  'Staging is not committing — run `git commit`, not just `git add`.',
  'Prefix the subject with fix:, feat:, chore:, or docs: when the category is clear.',
  'Your working directory is an isolated worktree with a unique branch for this task.',
  'Keep that branch name. Do not switch branches, modify another checkout, or create another worktree.',
  'Do not push; the branch stays local for review.'
].join('\n')

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: 'opencode',
    label: 'OpenCode',
    description: 'Default. ACP server over stdio, auto-approves tool use for each call.',
    command: 'opencode',
    args: ['acp'],
    executionProtocol: 'acp',
    defaultModel: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
    models: { kind: 'adapter', adapterId: 'opencode' }
  },
  {
    id: 'codex',
    label: 'Codex',
    description: 'App-server over stdio, unrestricted execution without approval prompts.',
    command: 'codex',
    args: ['app-server', '--listen', 'stdio://'],
    executionProtocol: 'codex-app-server',
    supportsSteering: true,
    defaultModel: 'gpt-5.6-sol',
    models: { kind: 'adapter', adapterId: 'codex' }
  }
]

export function getAgent(id: string): AgentDefinition | undefined {
  return BUILTIN_AGENTS.find((a) => a.id === id)
}
