import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION, type Client } from '@agentclientprotocol/sdk'
import { resolveCommand } from './resolve'
import { closeAgentServer } from './agent-server-process'

export interface OpenCodeAcpOptions {
  environment?: Readonly<NodeJS.ProcessEnv>
  serverCwd?: string
  command?: string
  args?: string[]
  startupTimeoutMs?: number
  cancelTimeoutMs?: number
  /** CLI arguments for querying model capabilities; defaults to models --verbose. */
  modelArgs?: string[]
}

/** Owns the persistent ACP transport, handshake, and process cleanup. */
export class OpenCodeAcpConnection {
  readonly rpc: ClientSideConnection
  readonly failure: Promise<never>
  private rejectFailure!: (error: Error) => void
  private failureError?: Error
  private child: ChildProcessWithoutNullStreams
  private closed: Promise<void>
  private closing?: Promise<void>
  private stderr = ''
  supportsLoadSession = false
  supportsImages = false

  constructor(cwd: string, private readonly options: OpenCodeAcpOptions, client: Client, private readonly diagnostic: (text: string) => void) {
    const command = options.command ?? 'opencode'
    const resolved = resolveCommand(command)
    if (!resolved) throw new Error(`"${command}" is not installed or not on PATH`)
    this.failure = new Promise<never>((_, reject) => { this.rejectFailure = reject })
    void this.failure.catch(() => {})
    this.child = spawn(resolved.command, [...resolved.prefixArgs, ...(options.args ?? ['acp'])], {
      cwd, shell: resolved.viaShell, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...(options.environment ?? process.env), PWD: cwd, NO_COLOR: '1', FORCE_COLOR: '0' }
    })
    this.closed = new Promise<void>((resolve) => { this.child.once('close', () => resolve()) })
    this.child.once('exit', (code, signal) => this.fail(new Error(`OpenCode ACP server exited before completing the turn (${signal ?? code}).`)))
    for (const stream of [this.child, this.child.stdin, this.child.stdout, this.child.stderr]) {
      stream.on('error', (error) => this.fail(error))
    }
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      const lines = (this.stderr + chunk).split('\n')
      this.stderr = lines.pop() ?? ''
      for (const line of lines) diagnostic(line)
    })
    this.child.stderr.on('end', () => this.flushDiagnostic())
    this.rpc = new ClientSideConnection(() => client, ndJsonStream(
      Writable.toWeb(this.child.stdin),
      Readable.toWeb(this.child.stdout) as ReadableStream<Uint8Array>
    ))
    void this.rpc.closed.then(() => this.fail(new Error('OpenCode ACP closed its connection')))
  }

  async initialize(): Promise<void> {
    const timer = setTimeout(() => this.fail(new Error('OpenCode ACP startup timed out.')), this.options.startupTimeoutMs ?? 60_000)
    try {
      const initialized = await Promise.race([this.rpc.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'anvil', version: '0.1.0' },
        clientCapabilities: {}
      }), this.failure])
      if (initialized.protocolVersion !== PROTOCOL_VERSION) throw new Error(`Unsupported ACP version: ${initialized.protocolVersion}`)
      this.supportsImages = initialized.agentCapabilities?.promptCapabilities?.image === true
      this.supportsLoadSession = Boolean(initialized.agentCapabilities?.loadSession)
    } finally {
      clearTimeout(timer)
    }
  }

  flushDiagnostic(): void {
    if (this.stderr) this.diagnostic(this.stderr)
    this.stderr = ''
  }

  /** Wait briefly for stderr to end so a trailing unterminated diagnostic is not raced. */
  async drainDiagnostic(timeoutMs = 100): Promise<void> {
    await Promise.race([
      new Promise<void>((resolve) => this.child.stderr.once('end', resolve)),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))
    ])
    this.flushDiagnostic()
  }

  fail(error: Error): void {
    if (this.failureError) return
    this.failureError = error
    this.rejectFailure(error)
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.fail(new Error('OpenCode connection closed'))
    this.closing = closeAgentServer(this.child, this.closed)
    return this.closing
  }
}
