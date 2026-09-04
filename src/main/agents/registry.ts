import type { AgentDefinition } from '../../shared/types'

export const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: 'opencode',
    label: 'opencode',
    description: 'Default. Non-interactive run, auto-approves tool use.',
    command: 'opencode',
    args: ['run', '--format', 'json', '--auto', '-m', '{{model}}', '{{prompt}}'],
    defaultModel: 'openrouter/google/gemini-2.5-flash',
    outputProtocol: 'opencode-json'
  },
  {
    id: 'claude',
    label: 'Claude Code',
    description: 'Headless print mode.',
    command: 'claude',
    args: ['-p', '--output-format', 'stream-json', '--verbose', '{{prompt}}'],
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
