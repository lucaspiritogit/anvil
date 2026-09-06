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
  'You start on a branch named after the task — rename it with `git branch -m` when a',
  'clearer name fits the work, using the same categories (e.g. fix/parser-null-token).',
  'Do not push; the branch stays local for review.'
].join('\n')

/**
 * Static picker defaults until model discovery uses app-server's model/list.
 */
const CODEX_MODELS = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: 'opencode',
    label: 'opencode',
    description: 'Default. ACP server over stdio, auto-approves tool use for each call.',
    command: 'opencode',
    args: ['acp'],
    executionProtocol: 'acp',
    defaultModel: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
    models: { kind: 'command', command: 'opencode', args: ['models'] }
  },
  {
    id: 'codex',
    label: 'Codex',
    description: 'App-server over stdio, non-interactive workspace-write sandbox.',
    command: 'codex',
    args: ['app-server', '--listen', 'stdio://'],
    executionProtocol: 'codex-app-server',
    defaultModel: CODEX_MODELS[0],
    models: { kind: 'static', models: CODEX_MODELS }
  },
  {
    id: 'pi',
    label: 'Pi',
    description: 'Non-interactive run.',
    command: 'pi',
    args: ['--print', '--mode', 'json', '{{prompt}}'],
    outputProtocol: 'pi-json'
  }
]

export function getAgent(id: string): AgentDefinition | undefined {
  return BUILTIN_AGENTS.find((a) => a.id === id)
}
