import type { WorkspaceExecutionContext } from './workspace-execution'
import { execFile } from 'node:child_process'
import { resolveCommand } from './resolve'
import { getAgentAdapter } from './adapters'
import type { AgentDefinition, ModelSource, ProviderModelList } from '../../shared/types'

/** A provider CLI that has not answered by now is not going to. */
const TIMEOUT_MS = 20_000
/** Verbose model catalogues include provider metadata and per-model variants. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024

/**
 * Catalogues change far more slowly than the modal is opened, so a list is
 * fetched once per app run. Only successful lists are kept: a CLI that was
 * still installing gets another chance next time the dropdown is opened.
 */
type CatalogueEntry =
  | { kind: 'resolved'; workspaceId: string; catalogue: ProviderModelList }
  | { kind: 'pending'; workspaceId: string; controller: AbortController; discovery: Promise<ProviderModelList> }

const cache = new Map<string, CatalogueEntry>()
const generations = new Map<string, number>()
const pausedWorkspaces = new Set<string>()
let closing = false

export async function pauseWorkspaceModelDiscovery(workspaceId: string): Promise<() => void> {
  pausedWorkspaces.add(workspaceId)
  const pending: Promise<ProviderModelList>[] = []
  for (const [key, entry] of cache) {
    if (entry.workspaceId !== workspaceId) continue
    cache.delete(key)
    if (entry.kind === 'pending') {
      entry.controller.abort()
      pending.push(entry.discovery)
    }
  }
  await Promise.allSettled(pending)
  invalidateWorkspaceModels(workspaceId)
  return () => { pausedWorkspaces.delete(workspaceId) }
}

export async function closeModelDiscovery(): Promise<void> {
  closing = true
  const pending: Promise<ProviderModelList>[] = []
  for (const entry of cache.values()) {
    if (entry.kind !== 'pending') continue
    entry.controller.abort()
    pending.push(entry.discovery)
  }
  cache.clear()
  await Promise.allSettled(pending)
}

/** Authentication changes must not retire a different workspace's catalogue. */
export function invalidateWorkspaceModels(workspaceId: string): void {
  generations.set(workspaceId, (generations.get(workspaceId) ?? 0) + 1)
  for (const [key, entry] of cache) {
    if (entry.workspaceId !== workspaceId) continue
    cache.delete(key)
    if (entry.kind === 'pending') entry.controller.abort()
  }
}

/** One identifier per line, in the order the provider printed them. */
function parseModelLines(stdout: string): string[] {
  const seen = new Set<string>()
  for (const line of stdout.split(/\r?\n/)) {
    const model = line.trim()
    if (model) seen.add(model)
  }
  return [...seen]
}

async function fromCommand(source: Extract<ModelSource, { kind: 'command' }>, workspace: WorkspaceExecutionContext, signal: AbortSignal): Promise<Pick<ProviderModelList, 'models' | 'reasoningByModel'>> {
  const resolved = resolveCommand(source.command)
  if (!resolved) throw new Error(`"${source.command}" is not installed or not on PATH`)

  const stdout = await new Promise<string>((resolve, reject) => {
    let output = ''
    let failure: Error | null = null
    const child = execFile(resolved.command, [...resolved.prefixArgs, ...source.args], {
      signal, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
      shell: resolved.viaShell, windowsHide: true, cwd: workspace.home,
      env: { ...workspace.environment, NO_COLOR: '1', FORCE_COLOR: '0' }
    }, (error, stdout) => {
      failure = error
      output = stdout
    })
    // Abort invokes execFile's callback before the child closes. Shutdown must
    // wait for the actual process, not only for cancellation acknowledgement.
    child.once('close', () => {
      if (failure) reject(failure)
      else resolve(output)
    })
  })
  return { models: parseModelLines(stdout) }
}

/**
 * The models an agent can be asked to run. Never rejects: a provider that
 * cannot be reached comes back as an empty list with the reason attached, so
 * the picker can fall back to a typed-in model instead of breaking the modal.
 */
export function listModels(agent: AgentDefinition, workspace: WorkspaceExecutionContext): Promise<ProviderModelList> {
  if (closing) return Promise.resolve({ agentId: agent.id, models: [], error: 'Model discovery is shutting down' })
  if (pausedWorkspaces.has(workspace.workspaceId)) return Promise.resolve({ agentId: agent.id, models: [], error: 'Workspace is being renamed. Retry shortly.' })
  const key = JSON.stringify([workspace.workspaceId, agent.id])
  const cached = cache.get(key)
  if (cached?.kind === 'resolved') return Promise.resolve(cached.catalogue)
  if (cached?.kind === 'pending') return cached.discovery

  const controller = new AbortController()
  const generation = generations.get(workspace.workspaceId) ?? 0
  let entry: Extract<CatalogueEntry, { kind: 'pending' }>
  const discovery = discoverModels(agent, workspace, controller.signal, generation).then((catalogue) => {
    if (cache.get(key) !== entry) return catalogue
    if (catalogue.models.length && !catalogue.error && !controller.signal.aborted && !closing && !pausedWorkspaces.has(workspace.workspaceId)) {
      cache.set(key, { kind: 'resolved', workspaceId: workspace.workspaceId, catalogue })
    } else {
      cache.delete(key)
    }
    return catalogue
  }, (error) => {
    if (cache.get(key) === entry) cache.delete(key)
    throw error
  })
  entry = { kind: 'pending', workspaceId: workspace.workspaceId, controller, discovery }
  cache.set(key, entry)
  return discovery
}

async function discoverModels(agent: AgentDefinition, workspace: WorkspaceExecutionContext, signal: AbortSignal, generation: number): Promise<ProviderModelList> {
  if (!agent.models) return { agentId: agent.id, models: [] }

  try {
    const source = agent.models
    const catalogue = source.kind === 'adapter'
      ? await getAgentAdapter(source.adapterId).listModels(agent, workspace, signal)
      : source.kind === 'static' ? { models: source.models } : await fromCommand(source, workspace, signal)
    if (!catalogue.models.length) {
      return {
        agentId: agent.id,
        models: [],
        error: `${agent.label} reported no models`
      }
    }
    const result = { agentId: agent.id, ...catalogue }
    if ((generations.get(workspace.workspaceId) ?? 0) !== generation) {
      return { agentId: agent.id, models: [], error: 'Workspace authentication changed during model discovery. Retry.' }
    }
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { agentId: agent.id, models: [], error: message }
  }
}
