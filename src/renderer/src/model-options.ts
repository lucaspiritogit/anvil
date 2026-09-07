export interface ModelOption {
  id: string
  name: string
  company: string
  providerId: string
  providerName: string
}

const companyLabels: Record<string, string> = {
  openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', nvidia: 'NVIDIA',
  deepseek: 'DeepSeek', 'moonshotai': 'Moonshot AI', 'z-ai': 'Z.ai', minimax: 'MiniMax',
  qwen: 'Qwen', 'x-ai': 'xAI', 'meta-llama': 'Meta'
}
const providerLabels: Record<string, string> = {
  ...companyLabels, openrouter: 'OpenRouter', opencode: 'OpenCode Zen',
  'opencode-go': 'OpenCode Go', codex: 'Codex'
}

function modelCompany(name: string, segments: string[]): string {
  if (/^(gpt-|chatgpt-|codex-|o[134](?:-|$))/.test(name)) return 'OpenAI'
  if (name.startsWith('claude-')) return 'Anthropic'
  if (name.startsWith('gemini-')) return 'Google'
  if (name.startsWith('deepseek-')) return 'DeepSeek'
  if (name.startsWith('kimi-')) return 'Moonshot AI'
  if (name.startsWith('glm-')) return 'Z.ai'
  if (name.startsWith('minimax-')) return 'MiniMax'
  if (name.startsWith('qwen')) return 'Qwen'
  if (name.startsWith('grok-')) return 'xAI'
  if (name.startsWith('nemotron-')) return 'NVIDIA'
  const namespace = segments.length > 1 ? segments.at(-2) ?? '' : ''
  // An aggregator is not the model's creator. Unknown creators remain in All companies.
  if (['openrouter', 'opencode', 'opencode-go'].includes(namespace)) return ''
  return companyLabels[namespace] ?? namespace
}

/** Display metadata only. The original ID selects the provider and its credentials. */
export function describeModel(id: string, agentId: string): ModelOption {
  const segments = id.split('/')
  const name = segments.at(-1) ?? id
  const normalized = name.toLowerCase()
  const providerId = id ? segments.length > 1 ? segments[0] : agentId : ''
  const versionedName = normalized.startsWith('claude-') ? name.replace(/-(\d+)-(\d+)(?=-|$)/, '-$1.$2') : name
  const displayName = /^(gpt-|chatgpt-|claude-|gemini-)/.test(normalized)
    ? versionedName.split('-').map((part) => part.toLowerCase() === 'gpt' ? 'GPT'
      : part.toLowerCase() === 'chatgpt' ? 'ChatGPT'
        : part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
    : name
  return {
    id, name: displayName, company: modelCompany(normalized, segments),
    providerId, providerName: providerLabels[providerId] ?? providerId
  }
}

export function groupModelsByProvider(options: ModelOption[]): { providerId: string; providerName: string; models: ModelOption[] }[] {
  const groups = new Map<string, { providerId: string; providerName: string; models: ModelOption[] }>()
  for (const option of options) {
    let group = groups.get(option.providerId)
    if (!group) {
      group = { providerId: option.providerId, providerName: option.providerName, models: [] }
      groups.set(option.providerId, group)
    }
    group.models.push(option)
  }
  return [...groups.values()]
}
