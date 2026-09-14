import { spawn } from 'node:child_process'
import { createOpencodeClient } from '@opencode-ai/sdk/client'
import type { AgentDefinition } from '../../shared/types'
import type { AgentModelCatalogue } from './adapters'
import { closeAgentServer } from './agent-server-process'
import { openCodeModelCatalogue } from './opencode-models'
import { openCodeWorkspaceEnvironment } from './opencode-workspace'
import { resolveCommand } from './resolve'
import type { WorkspaceExecutionContext } from './workspace-execution'

const DISCOVERY_TIMEOUT_MS = 20_000
const MAX_DIAGNOSTIC_BYTES = 64 * 1024

function retainDiagnostic(current: string, chunk: Buffer): string {
  if (current.length >= MAX_DIAGNOSTIC_BYTES) return current
  return (current + chunk.toString('utf8')).slice(0, MAX_DIAGNOSTIC_BYTES)
}

function listeningUrl(output: string): string | undefined {
  const match = output.match(/https?:\/\/[^\s]+/)
  if (!match) return undefined
  const url = new URL(match[0])
  if (url.hostname !== '127.0.0.1') throw new Error(`OpenCode SDK server listened on unexpected host ${url.hostname}`)
  return url.origin
}

/**
 * Start the OpenCode HTTP server with Anvil's resolved executable and isolated
 * workspace environment. The published SDK launcher cannot accept either.
 */
export async function discoverOpenCodeModels(
  agent: AgentDefinition,
  workspace: WorkspaceExecutionContext,
  signal?: AbortSignal
): Promise<AgentModelCatalogue> {
  const resolved = resolveCommand(agent.command)
  if (!resolved) throw new Error(`"${agent.command}" is not installed or not on PATH`)

  signal?.throwIfAborted()
  const timeoutController = new AbortController()
  const timeout = setTimeout(() => timeoutController.abort(new Error('OpenCode model discovery timed out.')), DISCOVERY_TIMEOUT_MS)
  const discoverySignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal
  discoverySignal.throwIfAborted()

  const child = spawn(resolved.command, [
    ...resolved.prefixArgs,
    'serve',
    '--hostname=127.0.0.1',
    '--port=0',
    '--mdns=false'
  ], {
    cwd: workspace.home,
    shell: resolved.viaShell,
    windowsHide: true,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...openCodeWorkspaceEnvironment(workspace),
      PWD: workspace.home,
      NO_COLOR: '1',
      FORCE_COLOR: '0'
    }
  })
  const closed = new Promise<void>((resolve) => { child.once('close', () => resolve()) })
  let output = ''
  let startupComplete = false

  const started = new Promise<string>((resolve, reject) => {
    const read = (chunk: Buffer): void => {
      output = retainDiagnostic(output, chunk)
      try {
        const url = listeningUrl(output)
        if (!url || startupComplete) return
        startupComplete = true
        resolve(url)
      } catch (error) {
        reject(error)
      }
    }
    child.stdout?.on('data', read)
    child.stderr?.on('data', read)
    child.once('error', reject)
    child.once('exit', (code, exitSignal) => {
      if (startupComplete) return
      const diagnostic = output.trim()
      reject(new Error(diagnostic || `OpenCode SDK server exited before startup (${exitSignal ?? code})`))
    })
  })
  let rejectAborted!: (reason?: unknown) => void
  const aborted = new Promise<never>((_, reject) => { rejectAborted = reject })
  const abort = (): void => rejectAborted(discoverySignal.reason)
  discoverySignal.addEventListener('abort', abort, { once: true })
  void aborted.catch(() => {})

  try {
    const url = await Promise.race([started, aborted])
    const client = createOpencodeClient({
      baseUrl: url,
      directory: workspace.home,
      throwOnError: true
    })
    const response = await Promise.race([
      client.provider.list({ query: { directory: workspace.home }, signal: discoverySignal }),
      aborted
    ])
    if (!response.data) throw new Error('OpenCode SDK returned no provider catalogue')
    return openCodeModelCatalogue(response.data)
  } finally {
    discoverySignal.removeEventListener('abort', abort)
    clearTimeout(timeout)
    await closeAgentServer(child, closed)
  }
}
