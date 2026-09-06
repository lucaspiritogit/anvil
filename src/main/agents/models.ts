import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveCommand } from './resolve'
import type { AgentDefinition, ModelSource, ProviderModelList } from '../../shared/types'

const task = promisify(execFile)

/** A provider CLI that has not answered by now is not going to. */
const TIMEOUT_MS = 20_000
/** `opencode models` prints a few hundred lines; leave room for growth. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/**
 * Catalogues change far more slowly than the modal is opened, so a list is
 * fetched once per app run. Only successful lists are kept: a CLI that was
 * still installing gets another chance next time the dropdown is opened.
 */
const cache = new Map<string, string[]>()

/** One identifier per line, in the order the provider printed them. */
function parseModelLines(stdout: string): string[] {
  const seen = new Set<string>()
  for (const line of stdout.split(/\r?\n/)) {
    const model = line.trim()
    if (model) seen.add(model)
  }
  return [...seen]
}

async function fromCommand(source: Extract<ModelSource, { kind: 'command' }>): Promise<string[]> {
  const resolved = resolveCommand(source.command)
  if (!resolved) throw new Error(`"${source.command}" is not installed or not on PATH`)

  const { stdout } = await task(resolved.command, [...resolved.prefixArgs, ...source.args], {
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_OUTPUT_BYTES,
    shell: resolved.viaShell,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
  })
  return parseModelLines(stdout)
}

/**
 * The models an agent can be asked to run. Never rejects: a provider that
 * cannot be reached comes back as an empty list with the reason attached, so
 * the picker can fall back to a typed-in model instead of breaking the modal.
 */
export async function listModels(agent: AgentDefinition): Promise<ProviderModelList> {
  const cached = cache.get(agent.id)
  if (cached) return { agentId: agent.id, models: cached }

  if (!agent.models) return { agentId: agent.id, models: [] }

  try {
    const models =
      agent.models.kind === 'static' ? agent.models.models : await fromCommand(agent.models)
    if (!models.length) {
      return {
        agentId: agent.id,
        models: [],
        error: `${agent.label} reported no models`
      }
    }
    cache.set(agent.id, models)
    return { agentId: agent.id, models }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { agentId: agent.id, models: [], error: message }
  }
}
