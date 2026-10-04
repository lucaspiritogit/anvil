import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { resolveCommand } from './resolve'
import { closeAgentServer } from './agent-server-process'
import { AgentTransportError, agentTransportFailure } from './agent-failure'
import type { AgentMcpServer } from './agent-executor'
import type { WorkspaceExecutionContext } from './workspace-execution'
import { claudeWorkspaceEnvironment } from './claude-workspace'

export type ClaudeObject = Record<string, unknown>

export interface ClaudeCodeConnectionOptions {
  workspace: WorkspaceExecutionContext
  cwd: string
  command?: string
  args?: string[]
  model?: string
  reasoningEffort?: string
  resumeSessionId?: string
  mcpServers?: AgentMcpServer[]
  readOnly?: boolean
  noSessionPersistence?: boolean
  safeMode?: boolean
  requestTimeoutMs?: number
}

export interface ClaudeCodeConnectionHandlers {
  message(message: ClaudeObject): void
  diagnostic?(line: string): void
}

export class ClaudeControlError extends Error {}

export function claudeObject(value: unknown): ClaudeObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Claude protocol object')
  return value as ClaudeObject
}

export async function requireClaudeCodeVersion(
  options: Pick<ClaudeCodeConnectionOptions, 'workspace' | 'command' | 'args'>,
  signal?: AbortSignal
): Promise<void> {
  const command = options.command ?? 'claude'
  const resolved = resolveCommand(command)
  if (!resolved || resolved.viaShell) throw new Error('Install Claude Code 2.1.288 or later and make it available on PATH.')
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(resolved.command, [...resolved.prefixArgs, ...(options.args ?? []), '--version'], {
      cwd: options.workspace.home, env: { ...claudeWorkspaceEnvironment(options.workspace) },
      timeout: 20_000, maxBuffer: 16_384, windowsHide: true, signal
    }, (error, output) => {
      if (error) reject(new Error('Could not check the Claude Code version. Install Claude Code 2.1.288 or later.'))
      else resolve(output)
    })
  })
  const match = /\b(\d+)\.(\d+)\.(\d+)\b/.exec(stdout)
  if (!match) throw new Error('Could not identify the Claude Code version. Install Claude Code 2.1.288 or later.')
  const [major, minor, patch] = match.slice(1).map(Number)
  if (major < 2 || (major === 2 && (minor < 1 || (minor === 1 && patch < 288)))) {
    throw new Error('Update Claude Code to 2.1.288 or later to use it in Anvil.')
  }
}

export class ClaudeCodeConnection {
  readonly failure: Promise<never>
  private rejectFailure!: (error: Error) => void
  private failureError?: Error
  private readonly child: ChildProcessWithoutNullStreams
  private readonly closed: Promise<void>
  private readonly abort = new AbortController()
  private closing?: Promise<void>
  private initialization?: Promise<ClaudeObject>
  private stderr = ''
  private readonly secrets: string[]
  private readonly pending = new Map<string, {
    resolve(value: ClaudeObject): void
    reject(error: Error): void
  }>()

  constructor(private readonly options: ClaudeCodeConnectionOptions, private readonly handlers: ClaudeCodeConnectionHandlers) {
    const command = options.command ?? 'claude'
    const resolved = resolveCommand(command)
    if (!resolved || resolved.viaShell) throw new Error('Install Claude Code 2.1.288 or later and make it available on PATH.')
    const servers = options.readOnly ? [] : options.mcpServers ?? []
    this.secrets = servers.flatMap((server) => Object.values(server.headers)).filter(Boolean)
    const mcpServers = Object.fromEntries(servers.map((server) => [server.name, {
      type: 'http', url: server.url, headers: server.headers
    }]))
    const args = [
      ...resolved.prefixArgs, ...(options.args ?? []),
      '--print', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--verbose', '--include-partial-messages', '--replay-user-messages',
      '--permission-prompts', 'none', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers })
    ]
    if (options.readOnly) {
      args.push('--permission-mode', 'dontAsk', '--tools', 'Read,Glob,Grep', '--allowedTools', 'Read,Glob,Grep')
    } else {
      args.push('--dangerously-skip-permissions')
    }
    if (options.model) args.push('--model', options.model)
    if (options.reasoningEffort) args.push('--effort', options.reasoningEffort)
    if (options.resumeSessionId) args.push('--resume', options.resumeSessionId)
    if (options.noSessionPersistence) args.push('--no-session-persistence')
    if (options.safeMode || options.readOnly) args.push('--safe-mode')
    this.failure = new Promise<never>((_, reject) => { this.rejectFailure = reject })
    void this.failure.catch(() => {})
    this.child = spawn(resolved.command, args, {
      cwd: options.cwd, env: { ...claudeWorkspaceEnvironment(options.workspace), PWD: options.cwd, NO_COLOR: '1', FORCE_COLOR: '0', CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1' },
      windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']
    })
    this.closed = new Promise<void>((resolve) => { this.child.once('close', () => resolve()) })
    for (const stream of [this.child, this.child.stdin, this.child.stdout, this.child.stderr]) {
      stream.on('error', (error: NodeJS.ErrnoException) => this.fail(agentTransportFailure(error)))
    }
    this.child.once('exit', (code, signal) => this.fail(new AgentTransportError(`Claude Code exited (${signal ?? code})`)))
    const stdout = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    stdout.on('line', (line) => {
      if (this.closing || this.failureError || !line.trim()) return
      try {
        if (line.length > 32 * 1024 * 1024) throw new Error('Claude protocol message exceeds the size limit')
        this.receive(claudeObject(JSON.parse(line)))
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    stdout.once('close', () => this.fail(new AgentTransportError('Claude Code closed stdout before execution finished')))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      const lines = (this.stderr + chunk).split(/\r?\n/)
      this.stderr = (lines.pop() ?? '').slice(-128_000)
      for (const line of lines) this.handlers.diagnostic?.(this.redact(line))
    })
    this.child.stderr.on('end', () => {
      if (this.stderr) this.handlers.diagnostic?.(this.redact(this.stderr))
      this.stderr = ''
    })
  }

  initialize(): Promise<ClaudeObject> {
    this.initialization ??= (async () => {
      await requireClaudeCodeVersion(this.options, this.abort.signal)
      return this.request('initialize', { sdkMcpServers: [] })
    })()
    return this.initialization
  }

  async send(message: ClaudeObject): Promise<void> {
    if (this.failureError) throw this.failureError
    if (this.closing) throw new Error('Claude connection is closed')
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) {
          const failure = agentTransportFailure(error)
          this.fail(failure)
          reject(failure)
        } else resolve()
      })
    })
  }

  async request(subtype: string, params: ClaudeObject = {}): Promise<ClaudeObject> {
    const requestId = randomUUID()
    const response = new Promise<ClaudeObject>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject })
    })
    void response.catch(() => {})
    const timeout = setTimeout(() => this.fail(new AgentTransportError(`Claude ${subtype} request timed out`)), this.options.requestTimeoutMs ?? 60_000)
    try {
      await this.send({ type: 'control_request', request_id: requestId, request: { ...params, subtype } })
      return await response
    } finally {
      clearTimeout(timeout)
      this.pending.delete(requestId)
    }
  }

  private receive(message: ClaudeObject): void {
    if (message.type === 'control_response') {
      const response = claudeObject(message.response)
      if (typeof response.request_id !== 'string') throw new Error('Invalid Claude control response ID')
      const pending = this.pending.get(response.request_id)
      if (!pending) return
      if (response.subtype === 'success') {
        pending.resolve(response.response === undefined ? {} : claudeObject(response.response))
      } else if (response.subtype === 'error') {
        pending.reject(new ClaudeControlError(typeof response.error === 'string' ? this.redact(response.error) : 'Claude control request failed'))
      } else throw new Error('Invalid Claude control response status')
      this.pending.delete(response.request_id)
      return
    }
    if (message.type === 'control_request') {
      if (typeof message.request_id !== 'string') throw new Error('Invalid Claude control request ID')
      const request = claudeObject(message.request)
      const response = request.subtype === 'can_use_tool'
        ? { subtype: 'success', request_id: message.request_id, response: { behavior: 'deny', message: 'This tool requires approval outside this Anvil execution.' } }
        : { subtype: 'error', request_id: message.request_id, error: 'Unsupported Claude control request' }
      void this.send({ type: 'control_response', response }).catch((error: Error) => this.fail(error))
      return
    }
    if (message.type === 'control_cancel_request') return
    if (typeof message.type !== 'string') throw new Error('Invalid Claude message type')
    this.handlers.message(message)
  }

  private redact(value: string): string {
    for (const secret of this.secrets) value = value.replaceAll(secret, '[redacted]')
    return value
  }

  private fail(error: Error): void {
    if (this.closing || this.failureError) return
    this.failureError = error
    this.rejectFailure(error)
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.abort.abort()
    this.fail(new Error('Claude connection closed'))
    this.closing = closeAgentServer(this.child, this.closed)
    return this.closing
  }
}
