import type { ProviderModelDisplay, ProviderModelList } from '@anvil/protocol/types'

export interface ModelOption {
  id: string
  name: string
  company: string
  providerId: string
  providerName: string
  resolvedModel?: string
}

const companyLabels: Record<string, string> = {
  openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google', nvidia: 'NVIDIA',
  deepseek: 'DeepSeek', 'moonshotai': 'Moonshot AI', 'z-ai': 'Z.ai', minimax: 'MiniMax',
  qwen: 'Qwen', 'x-ai': 'xAI', 'meta-llama': 'Meta'
}
const providerLabels: Record<string, string> = {
  ...companyLabels, openrouter: 'OpenRouter', opencode: 'OpenCode Zen',
  'opencode-go': 'OpenCode Go', codex: 'Codex', claude: 'Claude'
}

const modelWordLabels: Record<string, string> = {
  gpt: 'GPT', glm: 'GLM', oss: 'OSS', deepseek: 'DeepSeek', minimax: 'MiniMax',
  qwen: 'Qwen', chatgpt: 'ChatGPT', highspeed: 'HighSpeed'
}

export function humanizeModelName(id: string): string {
  const slug = id.split('/').at(-1) ?? id
  const normalized = slug
    .replace(/\((?:recommended|new|[\d.]+%\s*off)\)/gi, '')
    .replace(/[-_ ]20\d{6}(?=$|\[|:)/g, '')
    .replace(/^claude[-_ ](\d+)(?:[-_.](\d+))?[-_ ](opus|sonnet|haiku)(?=[-_ ]|$)/i,
      (_match, major: string, minor: string | undefined, family: string) => `${family}-${major}.${minor ?? '0'}`)
    .replace(/^claude[-_ ]+(?=(?:opus|sonnet|haiku|fable)(?:[-_ ]|$))/i, '')
    .replace(/\b(\d{1,2})[-_](\d{1,2})(?=[-_ :\[]|$)/g, '$1.$2')
    .replace(/^qwen(?=\d)/i, 'qwen ')
    .replace(/[^a-z0-9.]+/gi, ' ')
    .split(' ')
    .filter(Boolean)
  let versionFound = false
  return normalized.map((word) => {
    const version = /^([kvrm]?)(\d{1,3})(?:\.(\d+))?$/i.exec(word)
    if (!versionFound && version) {
      versionFound = true
      const prefix = version[1].toLowerCase() === 'v' ? '' : version[1].toUpperCase()
      return `${prefix}${version[2]}.${version[3] ?? '0'}`
    }
    const lower = word.toLowerCase()
    if (modelWordLabels[lower]) return modelWordLabels[lower]
    if (/^\d+b$/i.test(word)) return word.toUpperCase()
    if (lower === '1m') return '1M'
    return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  }).join(' ')
}

function modelDisplayName(id: string, display?: ProviderModelDisplay): string {
  const name = display?.name?.trim()
  const resolvedModel = display?.resolvedModel?.trim()
  const versionedName = name?.replace(/\[[^\]]*\]|\([^)]*\)/g, '').replace(/qwen(?=\d)/i, 'qwen ')
  const hasVersion = (value: string): boolean => /\b[kvrm]?\d{1,3}(?:[.-]\d+)?\b/i.test(value)
  let source = name || id
  if (resolvedModel && hasVersion(resolvedModel) && !hasVersion(versionedName ?? '')) {
    source = resolvedModel
  }
  let formatted = humanizeModelName(source)
  if (id.endsWith(':free') && !/\bfree\b/i.test(formatted)) formatted += ' Free'
  if ((/\[1m\]/i.test(id) || /\b1m\b/i.test(name ?? '')) && !/\b1m\b/i.test(formatted)) formatted += ' 1M'
  if (id === 'opusplan' && !/\bplan\b/i.test(formatted)) formatted += ' Plan Mode'
  if (/\bpreview\b/i.test(name ?? '') && !/\bpreview\b/i.test(formatted)) formatted += ' Preview'
  return formatted
}

export function normalizeModelSearch(value: string): string {
  return value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function modelMatchesQuery(option: ModelOption, query: string): boolean {
  const normalizedQuery = normalizeModelSearch(query)
  if (!normalizedQuery) return true
  const searchable = [option.name, option.id, option.resolvedModel, option.company, option.providerId, option.providerName].join(' ')
  return normalizeModelSearch(searchable).includes(normalizedQuery)
}

function modelCompany(name: string, segments: string[]): string {
  if (/^(gpt-|chatgpt-|codex-|o[134](?:-|$))/.test(name)) return 'OpenAI'
  if (/^(?:claude(?:-|$)|(?:opus|sonnet|haiku|fable)(?:\[1m\])?$|opusplan$)/.test(name)) return 'Anthropic'
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
export function describeModel(id: string, agentId: string, display?: ProviderModelDisplay): ModelOption {
  const segments = id.split('/')
  const name = segments.at(-1) ?? id
  const normalized = name.toLowerCase()
  const providerId = id ? agentId === 'claude' ? 'claude' : segments.length > 1 ? segments[0] : agentId : ''
  return {
    id, name: modelDisplayName(id, display), company: agentId === 'claude' && id ? 'Anthropic' : modelCompany(normalized, segments),
    providerId, providerName: providerLabels[providerId] ?? providerId,
    ...(display?.resolvedModel ? { resolvedModel: display.resolvedModel } : {})
  }
}

export function catalogueModelOptions(catalogue: ProviderModelList | undefined, agentId: string, selectedModel = ''): ModelOption[] {
  const models = selectedModel ? [selectedModel, ...(catalogue?.models ?? [])] : catalogue?.models ?? []
  const seen = new Set<string>()
  const options: ModelOption[] = []
  for (const id of models) {
    const display = catalogue?.displayByModel?.[id]
    const option = describeModel(id, agentId, display)
    const resolvedModel = display?.resolvedModel || id
    const key = JSON.stringify([option.providerId, resolvedModel, /\[1m\]/i.test(id), id.endsWith(':free'), id === 'opusplan'])
    if (seen.has(key)) continue
    seen.add(key)
    options.push(option)
  }
  return options
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

const subscriptionOrder = ['openrouter', 'opencode-go', 'opencode']

export function groupModelsBySubscription(options: ModelOption[]): { id: string; title: string; models: ModelOption[] }[] {
  const providerGroups = groupModelsByProvider(options)
  const groups = subscriptionOrder.map((id) => ({
    id,
    title: providerLabels[id],
    models: providerGroups.find((group) => group.providerId === id)?.models ?? []
  }))
  // Keep custom and directly configured routes available without grouping by model company.
  groups.push({
    id: 'other',
    title: 'Other models',
    models: options.filter((option) => !subscriptionOrder.includes(option.providerId))
  })
  return groups.filter((group) => group.models.length > 0)
}
