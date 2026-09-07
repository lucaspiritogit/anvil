import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveCommand } from './resolve'
import { parseOpenCodeModels } from './opencode-models'
import type { AgentDefinition, ModelSource, ProviderModelList } from '../../shared/types'

const task = promisify(execFile)

/** A provider CLI that has not answered by now is not going to. */
const TIMEOUT_MS = 20_000
/** Verbose model catalogues include provider metadata and per-model variants. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024

/**
 * Catalogues change far more slowly than the modal is opened, so a list is
 * fetched once per app run. Only successful lists are kept: a CLI that was
 * still installing gets another chance next time the dropdown is opened.
 */
const cache = new Map<string, ProviderModelList>()

/** One identifier per line, in the order the provider printed them. */
function parseModelLines(stdout: string): string[] {
  const seen = new Set<string>()
  for (const line of stdout.split(/\r?\n/)) {
    const model = line.trim()
    if (model) seen.add(model)
  }
  return [...seen]
}

async function fromCommand(source: Extract<ModelSource, { kind: 'command' }>): Promise<Pick<ProviderModelList, 'models' | 'effortsByModel'>> {
  const resolved = resolveCommand(source.command)
  if (!resolved) throw new Error(`"${source.command}" is not installed or not on PATH`)

  const { stdout } = await task(resolved.command, [...resolved.prefixArgs, ...source.args], {
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: resolved.viaShell,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
  })
  return source.format === 'opencode-verbose' ? parseOpenCodeModels(stdout) : { models: parseModelLines(stdout) }
}

/**
 * The models an agent can be asked to run. Never rejects: a provider that
 * cannot be reached comes back as an empty list with the reason attached, so
 * the picker can fall back to a typed-in model instead of breaking the modal.
 */
export async function listModels(agent: AgentDefinition): Promise<ProviderModelList> {
  const cached = cache.get(agent.id)
  if (cached) return cached

  if (!agent.models) return { agentId: agent.id, models: [] }

  try {
    const catalogue = agent.models.kind === 'static' ? { models: agent.models.models } : await fromCommand(agent.models)
    if (!catalogue.models.length) {
      return {
        agentId: agent.id,
        models: [],
        error: `${agent.label} reported no models`
      }
    }
    const result = { agentId: agent.id, ...catalogue }
    cache.set(agent.id, result)
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { agentId: agent.id, models: [], error: message }
  }
}
