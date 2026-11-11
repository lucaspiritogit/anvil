import { execFile } from 'node:child_process'
import { UPDATABLE_AGENT_IDS, type AgentUpdateState, type UpdatableAgentId } from '@anvil/protocol/agent-updates'
import { compareVersions, parseVersion } from '@anvil/protocol/server-updates'
import { resolveCommand } from './resolve'

export const AGENT_UPDATE_CACHE_MS = 30 * 60_000
const VERSION_TIMEOUT_MS = 20_000
const UPDATE_TIMEOUT_MS = 10 * 60_000
const REGISTRY_URL = 'https://registry.npmjs.org'

const TARGETS: Record<UpdatableAgentId, { label: string; command: string; package: string }> = {
  codex: { label: 'Codex', command: 'codex', package: '@openai/codex' },
  claude: { label: 'Claude Code', command: 'claude', package: '@anthropic-ai/claude-code' }
}

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>
type Run = (command: string, args: string[], timeoutMs: number) => Promise<string | null>

export interface AgentUpdatesOptions {
  onChange?(states: AgentUpdateState[]): void
  onUpdated?(agentId: UpdatableAgentId): void
  fetch?: Fetch
  run?: Run
  now?(): number
}

function lastLine(value: string): string {
  return value.trim().split(/\r?\n/).pop()?.trim().slice(0, 300) ?? ''
}

const runAgentCommand: Run = (command, args, timeoutMs) => {
  const resolved = resolveCommand(command)
  if (!resolved) return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    execFile(resolved.command, [...resolved.prefixArgs, ...args], {
      timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, shell: resolved.viaShell
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(lastLine(String(stderr)) || lastLine(String(stdout)) || error.message))
      else resolve(String(stdout))
    })
  })
}

export function installedAgentVersion(output: string): string | null {
  const match = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/.exec(output)
  return match ? parseVersion(match[0]) : null
}

export async function installedAgentVersions(agents: Array<{ id: string; command: string }>, run: Run = runAgentCommand): Promise<Record<string, string | null>> {
  const entries = await Promise.all(agents.map(async ({ id, command }) => {
    try {
      const output = await run(command, ['--version'], VERSION_TIMEOUT_MS)
      return [id, output === null ? null : installedAgentVersion(output)] as const
    } catch {
      return [id, null] as const
    }
  }))
  return Object.fromEntries(entries)
}

export function createAgentUpdates(options: AgentUpdatesOptions = {}) {
  const now = options.now ?? Date.now
  const request: Fetch = options.fetch ?? ((url, init) => fetch(url, init))
  const run = options.run ?? runAgentCommand
  const states = new Map<UpdatableAgentId, AgentUpdateState>(UPDATABLE_AGENT_IDS.map((agentId) => [agentId, {
    agentId,
    label: TARGETS[agentId].label,
    installed: false,
    currentVersion: null,
    latestVersion: null,
    available: false,
    updating: false,
    error: null,
    checkedAt: null
  }]))
  const held = new Map<UpdatableAgentId, string>()
  let checkedAt: number | null = null
  let checking: Promise<AgentUpdateState[]> | null = null

  const get = (agentId: UpdatableAgentId): AgentUpdateState => states.get(agentId)!
  const snapshot = (): AgentUpdateState[] => UPDATABLE_AGENT_IDS.map(get)
  const set = (agentId: UpdatableAgentId, patch: Partial<AgentUpdateState>): void => {
    states.set(agentId, { ...get(agentId), ...patch })
    options.onChange?.(snapshot())
  }

  const latest = async (name: string): Promise<string | null> => {
    const response = await request(`${REGISTRY_URL}/${name}/latest`, { signal: AbortSignal.timeout(15_000) })
    if (!response.ok) throw new Error(`Registry responded with ${response.status}`)
    const body = await response.json() as { version?: unknown }
    return typeof body.version === 'string' ? parseVersion(body.version) : null
  }

  const refresh = async (agentId: UpdatableAgentId, patch: Partial<AgentUpdateState> = {}): Promise<void> => {
    const target = TARGETS[agentId]
    let installed = false
    let currentVersion: string | null = null
    try {
      const output = await run(target.command, ['--version'], VERSION_TIMEOUT_MS)
      installed = output !== null
      currentVersion = output === null ? null : installedAgentVersion(output)
    } catch {
      installed = true
    }
    let latestVersion = get(agentId).latestVersion
    if (currentVersion) {
      try {
        latestVersion = await latest(target.package) ?? latestVersion
      } catch {}
    }
    const available = !!currentVersion && !!latestVersion && latestVersion !== held.get(agentId) && compareVersions(latestVersion, currentVersion) > 0
    set(agentId, { ...patch, installed, currentVersion, latestVersion, available, checkedAt: now() })
  }

  const check = (force = false): Promise<AgentUpdateState[]> => {
    if (!force && checkedAt !== null && now() - checkedAt < AGENT_UPDATE_CACHE_MS) return Promise.resolve(snapshot())
    checking ??= Promise.all(UPDATABLE_AGENT_IDS.filter((agentId) => !get(agentId).updating).map((agentId) => refresh(agentId)))
      .then(() => {
        checkedAt = now()
        return snapshot()
      })
      .finally(() => { checking = null })
    return checking
  }

  const install = (agentId: UpdatableAgentId): AgentUpdateState[] => {
    const target = TARGETS[agentId]
    const state = get(agentId)
    if (state.updating) return snapshot()
    if (!state.installed) throw new Error(`${target.label} is not installed on this machine.`)
    const previousVersion = state.currentVersion
    set(agentId, { updating: true, error: null })
    void (async () => {
      let error: string | null = null
      try {
        await run(target.command, ['update'], UPDATE_TIMEOUT_MS)
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure)
      }
      await refresh(agentId, { updating: false })
      const next = get(agentId)
      if (error) set(agentId, { error: next.available ? error : null })
      else if (next.available && next.latestVersion) {
        held.set(agentId, next.latestVersion)
        set(agentId, { available: false })
      }
      if (get(agentId).currentVersion !== previousVersion) options.onUpdated?.(agentId)
    })()
    return snapshot()
  }

  return { state: snapshot, check, install }
}

export type AgentUpdates = ReturnType<typeof createAgentUpdates>
