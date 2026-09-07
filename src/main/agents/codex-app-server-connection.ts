import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { resolveCommand } from './resolve'
import { closeAgentServer } from './agent-server-process'
import {
  codexObject, validateCodexResponse,
  type CodexAppServerProtocol, type CodexAppServerRequests, type CodexObject, type CodexRequestId
} from './codex-app-server-protocol'

export interface CodexAppServerOptions {
  command?: string
  args?: string[]
  requestTimeoutMs?: number
  cancelTimeoutMs?: number
}

export interface ConnectionHandlers {
  notification(method: string, params: CodexObject): void
  serverRequest(method: string, params: CodexObject): unknown
  diagnostic(text: string): void
}

export class CodexRpcError extends Error {
  constructor(readonly code: number, message: string) { super(message) }
}

/** Owns Codex's headerless JSON-RPC framing, pending requests, and process cleanup. */
export class CodexAppServerConnection implements CodexAppServerProtocol {
  readonly failure: Promise<never>
  private rejectFailure!: (error: Error) => void
  private failureError: Error | undefined
  private child: ChildProcessWithoutNullStreams
  private closed: Promise<void>
  private closing?: Promise<void>
  private stderr = ''
  private nextId = 1
  private pending = new Map<CodexRequestId, {
    resolve(value: unknown): void
    reject(error: Error): void
  }>()

  constructor(cwd: string, private readonly options: CodexAppServerOptions, private readonly handlers: ConnectionHandlers) {
    const command = options.command ?? 'codex'
    const resolved = resolveCommand(command)
    if (!resolved) throw new Error(`"${command}" is not installed or not on PATH`)
    this.failure = new Promise<never>((_, reject) => { this.rejectFailure = reject })
    void this.failure.catch(() => {})
    this.child = spawn(resolved.command, [...resolved.prefixArgs, ...(options.args ?? ['app-server', '--listen', 'stdio://'])], {
      cwd, shell: resolved.viaShell, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PWD: cwd, NO_COLOR: '1', FORCE_COLOR: '0' }
    })
    this.closed = new Promise<void>((resolve) => { this.child.once('close', () => resolve()) })
    this.child.on('error', (error) => this.fail(error))
    this.child.stdin.on('error', (error) => this.fail(error))
    this.child.stdout.on('error', (error) => this.fail(error))
    this.child.stderr.on('error', (error) => this.fail(error))
    this.child.once('exit', (code, signal) => this.fail(new Error(`Codex app-server exited (${signal ?? code})`)))
    const stdout = createInterface({ input: this.child.stdout, crlfDelay: Infinity })
    stdout.on('line', (line) => {
      if (this.closing || this.failureError || !line.trim()) return
      try {
        this.receive(codexObject(JSON.parse(line)))
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
      }
    })
    stdout.once('close', () => this.fail(new Error('Codex app-server closed stdout before execution finished')))
    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      const lines = (this.stderr + chunk).split('\n')
      this.stderr = lines.pop() ?? ''
      for (const line of lines) handlers.diagnostic(line)
    })
    this.child.stderr.on('end', () => this.flushDiagnostic())
  }

  fail(error: Error): void {
    if (this.closing || this.failureError) return
    this.failureError = error
    this.rejectFailure(error)
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }

  private send(message: unknown): void {
    if (this.failureError) throw this.failureError
    if (this.closing) throw new Error('Codex connection is closed')
    // Codex deliberately omits the jsonrpc field. Never use an ACP connection here.
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => { if (error) this.fail(error) })
  }

  initialized(): void {
    this.send({ method: 'initialized', params: {} })
  }

  async request<Method extends keyof CodexAppServerRequests>(
    method: Method, params: CodexAppServerRequests[Method]['params']
  ): Promise<CodexAppServerRequests[Method]['result']> {
    const id = this.nextId++
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      try { this.send({ id, method, params }) } catch (error) { reject(error) }
    })
    const timeout = setTimeout(() => this.fail(new Error(`Codex ${method} request timed out`)), this.options.requestTimeoutMs ?? 60_000)
    try {
      const value = await response
      validateCodexResponse(method, value)
      return value as CodexAppServerRequests[Method]['result']
    } finally {
      clearTimeout(timeout)
      this.pending.delete(id)
    }
  }

  private receive(message: CodexObject): void {
    const id = message.id
    if (id !== undefined && typeof id !== 'number' && typeof id !== 'string') throw new Error('Invalid Codex request ID')
    if (typeof message.method === 'string') {
      const params = message.params === undefined ? {} : codexObject(message.params)
      if (id === undefined) {
        this.handlers.notification(message.method, params)
      } else {
        try {
          const result = this.handlers.serverRequest(message.method, params)
          this.send({ id, result })
        } catch (error) {
          this.send({ id, error: {
            code: error instanceof CodexRpcError ? error.code : -32603,
            message: error instanceof Error ? error.message : String(error)
          } })
        }
      }
      return
    }
    if (id === undefined || (!('result' in message) && !('error' in message))) throw new Error('Invalid Codex response')
    if ('result' in message && 'error' in message) throw new Error('Ambiguous Codex response')
    const pending = this.pending.get(id)
    if (!pending) return
    if ('error' in message) {
      const error = codexObject(message.error)
      pending.reject(new CodexRpcError(typeof error.code === 'number' ? error.code : -32603, String(error.message ?? 'Codex request failed')))
    } else {
      pending.resolve(message.result)
    }
    this.pending.delete(id)
  }

  flushDiagnostic(): void {
    if (this.stderr) this.handlers.diagnostic(this.stderr)
    this.stderr = ''
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.fail(new Error('Codex connection closed'))
    this.closing = closeAgentServer(this.child, this.closed)
    return this.closing
  }
}
