import type { ProviderModelList } from '../../shared/types'

/** `opencode models --verbose` emits an ID followed by a pretty-printed JSON object. */
export function parseOpenCodeModels(stdout: string): Pick<ProviderModelList, 'models' | 'effortsByModel' | 'reasoningByModel'> {
  const efforts = new Map<string, string[]>()
  const lines = stdout.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const model = lines[index].trim()
    if (!model) continue
    if (!model.includes('/') || lines[++index] !== '{') throw new Error('Invalid OpenCode model metadata')
    const start = index
    while (index < lines.length && lines[index] !== '}') index++
    if (index === lines.length) throw new Error(`Incomplete OpenCode metadata for ${model}`)
    const metadata = JSON.parse(lines.slice(start, index + 1).join('\n')) as { variants?: unknown }
    if (metadata.variants != null && (typeof metadata.variants !== 'object' || Array.isArray(metadata.variants))) {
      throw new Error(`Invalid OpenCode efforts for ${model}`)
    }
    efforts.set(model, Object.keys(metadata.variants ?? {}))
  }
  return {
    models: [...efforts.keys()],
    effortsByModel: Object.fromEntries(efforts),
    reasoningByModel: Object.fromEntries([...efforts].map(([model, ids]) => [model, {
      options: ids.map((id) => ({ id, label: id }))
    }]))
  }
}
