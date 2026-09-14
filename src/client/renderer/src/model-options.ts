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

const modelWordLabels: Record<string, string> = {
  ai: 'AI', api: 'API', chatgpt: 'ChatGPT', codex: 'Codex', deepseek: 'DeepSeek',
  gpt: 'GPT', llm: 'LLM', minimax: 'MiniMax', ocr: 'OCR', openai: 'OpenAI',
  oss: 'OSS', qwen: 'Qwen', rag: 'RAG', sql: 'SQL', stt: 'STT', tts: 'TTS',
  vl: 'VL', vlm: 'VLM'
}

function labelModelWord(word: string): string {
  const lower = word.toLowerCase()
  if (modelWordLabels[lower]) return modelWordLabels[lower]
  if (/^\d+[a-z]+$/i.test(word)) return word.toUpperCase()
  if (/^[a-z]\d[\da-z]*$/i.test(word)) return word.toUpperCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

export function humanizeModelName(id: string): string {
  const slug = id.split('/').at(-1) ?? id
  const words = slug
    .replace(/[^a-z0-9.]+/gi, '-')
    .replace(/(?<!\d)\.|\.(?!\d)/g, '-')
    .split('-')
    .filter(Boolean)
  const labelled: string[] = []
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]
    const next = words[index + 1]
    if (/^\d$/.test(word) && /^\d$/.test(next ?? '')) {
      labelled.push(`${word}.${next}`)
      index += 1
    } else {
      const separated = word.match(/^([a-z]{2,})(\d+(?:\.\d+)?)$/i)
      if (separated) labelled.push(labelModelWord(separated[1]), separated[2])
      else labelled.push(labelModelWord(word))
    }
  }
  return labelled.join(' ')
}

export function normalizeModelSearch(value: string): string {
  return value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function modelMatchesQuery(option: ModelOption, query: string): boolean {
  const normalizedQuery = normalizeModelSearch(query)
  if (!normalizedQuery) return true
  const searchable = [option.name, option.id, option.company, option.providerId, option.providerName].join(' ')
  const normalizedSearchable = normalizeModelSearch(searchable)
  const terms = query.trim().split(/\s+/).map(normalizeModelSearch)
  return normalizedSearchable.includes(normalizedQuery)
    || terms.every((term) => normalizedSearchable.includes(term))
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
  return {
    id, name: humanizeModelName(id), company: modelCompany(normalized, segments),
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
