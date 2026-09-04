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

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: 'opencode',
    label: 'opencode',
    description: 'Default. Non-interactive run, auto-approves tool use.',
    command: 'opencode',
    args: ['run', '--format', 'json', '--auto', '-m', '{{model}}', '{{prompt}}'],
    resumeArgs: [
      'run',
      '--format',
      'json',
      '--auto',
      '-m',
      '{{model}}',
      '-s',
      '{{session}}',
      '{{prompt}}'
    ],
    defaultModel: 'openrouter/nvidia/nemotron-3-ultra-550b-a55b:free',
    outputProtocol: 'opencode-json'
  },
  {
    id: 'claude',
    label: 'Claude Code',
    description: 'Headless print mode.',
    command: 'claude',
    args: ['-p', '--output-format', 'stream-json', '--verbose', '{{prompt}}'],
    resumeArgs: [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--resume',
      '{{session}}',
      '{{prompt}}'
    ],
    outputProtocol: 'claude-json'
  },
  {
    id: 'codex',
    label: 'Codex',
    description: 'Non-interactive exec mode.',
    command: 'codex',
    args: ['exec', '--json', '{{prompt}}'],
    outputProtocol: 'codex-json'
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
