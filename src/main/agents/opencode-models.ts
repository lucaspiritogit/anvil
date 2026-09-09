import { readOpenCodeModelOutput } from './opencode-model-output'
import type { ProviderModelList } from '../../shared/types'

/** `opencode models --verbose` emits an ID followed by a pretty-printed JSON object. */
export function parseOpenCodeModels(stdout: string): Pick<ProviderModelList, 'models' | 'reasoningByModel'> {
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
    reasoningByModel: Object.fromEntries([...efforts].map(([model, ids]) => [model, {
      options: ids.map((id) => ({ id, label: id }))
    }]))
  }
}

/** ACP has no per-model image capability field. Query the same CLI in the task's project context. */
export async function requireOpenCodeImageModel(command: string, args: string[], cwd: string, model: string | undefined, signal?: AbortSignal): Promise<void> {
  if (!model) throw new Error('Select an explicit image-capable OpenCode model before attaching images.')
  const stdout = await readOpenCodeModelOutput(command, args, cwd, signal)
  const lines = stdout.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === model)
  const end = lines.findIndex((line, index) => index > start + 1 && line === '}')
  if (start >= 0 && lines[start + 1] === '{' && end > start) {
    const metadata = JSON.parse(lines.slice(start + 1, end + 1).join('\n'))
    if (metadata?.capabilities?.input?.image === true) return
  }
  throw new Error(`OpenCode model ${model} does not advertise image input. Select an image-capable model or configure its input modalities to include image.`)
}
