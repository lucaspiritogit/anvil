import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import type { Store } from '../store'
import { TerminalManager } from '../terminal'
import type { AgentAccountTarget, AgentAccountConnect, WorkspaceAgentAccount, TerminalSnapshot } from '../../shared/types'
import { CodexAppServerConnection, type ConnectionHandlers } from './codex-app-server-connection'
import type { CodexAppServerProtocol, CodexObject } from './codex-app-server-protocol'
import { resolveWorkspaceExecution, type WorkspaceExecutionContext } from './workspace-execution'
import { openCodeWorkspaceCommand } from './opencode-workspace'
import { verifyWorkspaceOpenCode } from './opencode-model-output'
import { resolveCommand } from './resolve'

interface AccountConnection extends CodexAppServerProtocol {
  close(): Promise<void>
  failure: Promise<never>
}

export interface AccountDependencies {
  acquire(workspaceId: string): () => void
  busy(workspaceId: string): boolean
  invalidate(workspaceId: string): Promise<void>
  openBrowser(url: string): Promise<void>
  connection?(workspace: WorkspaceExecutionContext, handlers: ConnectionHandlers): AccountConnection
  verifyOpenCode?(workspace: WorkspaceExecutionContext): Promise<void>
  readOpenCode?(workspace: WorkspaceExecutionContext): Promise<string>
  changed?(state: WorkspaceAgentAccount): void
}

interface PendingAccount {
  target: AgentAccountTarget
  sessionId: string
  release(): void
  connection?: AccountConnection
  loginId?: string
  terminalId?: string
  timer?: ReturnType<typeof setTimeout>
  finishing?: Promise<WorkspaceAgentAccount>
  earlyNotifications: CodexObject[]
}

const PROVIDERS = [
  ['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['openrouter', 'OpenRouter'],
  ['opencode', 'OpenCode Zen'], ['opencode-go', 'OpenCode Go']
] as const

/** Return only recognized provider labels and credential kinds, never arbitrary CLI output. */
export function parseOpenCodeAccounts(output: string): string[] {
  const plain = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  const accounts: string[] = []
  for (const line of plain.split(/\r?\n/)) {
    for (const [id, label] of PROVIDERS) {
      if (line.includes(label + ' ') || line.includes(id + ' ')) {
        const method = /\b(oauth|api)\b/.exec(line)?.[1]
        if (method) accounts.push(`${label}: ${method === 'oauth' ? 'subscription' : 'API key'}`)
      }
    }
  }
  return [...new Set(accounts)]
}

function readNativeOpenCode(workspace: WorkspaceExecutionContext): Promise<string> {
  const launch = openCodeWorkspaceCommand(workspace, ['auth', 'list'])
  const resolved = resolveCommand(launch.command)
  if (!resolved) return Promise.reject(new Error('OpenCode unavailable'))
  return new Promise((resolve, reject) => {
    execFile(resolved.command, [...resolved.prefixArgs, ...launch.args], {
      cwd: launch.cwd, env: { ...launch.environment, NO_COLOR: '1', FORCE_COLOR: '0' },
      shell: resolved.viaShell, timeout: 20_000, maxBuffer: 128_000, windowsHide: true
    }, (error, stdout) => {
      if (error) reject(new Error('OpenCode account status unavailable'))
      else resolve(stdout)
    })
  })
}

/** Owns native authentication lifetimes independently of the selected renderer workspace. */
export class WorkspaceAccounts {
  private readonly states = new Map<string, WorkspaceAgentAccount>()
  private readonly pending = new Map<string, PendingAccount>()
  private readonly revisions = new Map<string, number>()
  readonly terminals: TerminalManager
  private closed = false
  private closing?: Promise<void>
  private readonly reads = new Map<string, Promise<WorkspaceAgentAccount>>()

  constructor(private readonly store: Pick<Store, 'getWorkspaceDirectory' | 'getWorkspaces'>, private readonly dependencies: AccountDependencies) {
    this.terminals = new TerminalManager({
      // Terminal output is available only through the account session bridge. It
      // is never broadcast as task output or written to diagnostics or storage.
      onData: () => {},
      onExit: (id, code) => {
        const operation = [...this.pending.values()].find((item) => item.terminalId === id)
        if (operation) void this.finish(operation, code === 0 ? undefined : 'Native account command failed. Retry the connection.')
      }
    })
  }

  private key(target: AgentAccountTarget): string { return JSON.stringify([target.workspaceId, target.agentId]) }

  private workspace(target: AgentAccountTarget): WorkspaceExecutionContext {
    if (this.closed) throw new Error('Account management is shutting down')
    if (!this.store.getWorkspaces().some((workspace) => workspace.id === target.workspaceId)) throw new Error('Workspace not found')
    return resolveWorkspaceExecution(this.store, target.workspaceId)
  }

  private state(target: AgentAccountTarget, patch: Partial<WorkspaceAgentAccount> = {}): WorkspaceAgentAccount {
    const workspaceName = this.store.getWorkspaces().find((workspace) => workspace.id === target.workspaceId)?.name ?? target.workspaceId
    return { ...target, workspaceName, status: 'signed-out', accounts: [], busy: this.dependencies.busy(target.workspaceId), ...patch }
  }

  private publish(state: WorkspaceAgentAccount): WorkspaceAgentAccount {
    this.states.set(this.key(state), state)
    this.dependencies.changed?.(state)
    return state
  }

  private connectCodex(workspace: WorkspaceExecutionContext, notification: ConnectionHandlers['notification'] = () => {}): AccountConnection {
    const handlers: ConnectionHandlers = { notification, diagnostic: () => {}, serverRequest: () => { throw new Error('Unsupported account server request') } }
    return this.dependencies.connection?.(workspace, handlers) ?? new CodexAppServerConnection(workspace.home, { workspace }, handlers)
  }

  private async initialize(connection: AccountConnection): Promise<void> {
    await connection.request('initialize', { clientInfo: { name: 'anvil_accounts', title: 'Anvil workspace accounts', version: '1.0.0' } })
    connection.initialized()
    const { config } = await connection.request('config/read', { includeLayers: false })
    if (config.cli_auth_credentials_store !== 'file') throw new Error('Codex did not confirm workspace file credential storage')
  }

  private async read(target: AgentAccountTarget): Promise<WorkspaceAgentAccount> {
    const workspace = this.workspace(target)
    if (target.agentId === 'opencode') {
      await this.verify(workspace)
      const accounts = parseOpenCodeAccounts(await (this.dependencies.readOpenCode ?? readNativeOpenCode)(workspace))
      return this.state(target, { status: accounts.length ? 'connected' : 'signed-out', accounts })
    }
    const connection = this.connectCodex(workspace)
    try {
      await this.initialize(connection)
      const { account } = await connection.request('account/read', { refreshToken: false })
      const accounts = account === null ? [] : account.type === 'apiKey' ? ['API key'] : account.type === 'chatgpt'
        ? [`ChatGPT${account.email ? `: ${account.email}` : ''} (${account.planType})`] : ['Amazon Bedrock']
      return this.state(target, { status: account ? 'connected' : 'signed-out', accounts })
    } finally { await connection.close() }
  }

  status(target: AgentAccountTarget): Promise<WorkspaceAgentAccount> {
    this.workspace(target)
    const key = this.key(target)
    if (this.pending.has(key)) return Promise.resolve(this.states.get(key)!)
    const existing = this.reads.get(key)
    if (existing) return existing
    const read = this.refreshStatus(target).finally(() => this.reads.delete(key))
    this.reads.set(key, read)
    return read
  }

  private async refreshStatus(target: AgentAccountTarget): Promise<WorkspaceAgentAccount> {
    this.workspace(target)
    const key = this.key(target)
    if (this.pending.has(key)) return this.states.get(key)!
    const revision = this.revisions.get(key)
    let state: WorkspaceAgentAccount
    try { state = await this.read(target) }
    catch { state = this.state(target, { status: 'error', message: 'Could not read the native account. Check that the supported agent CLI is installed and retry.' }) }
    if (revision !== this.revisions.get(key)) return this.states.get(key)!
    return this.publish(state)
  }

  private async verify(workspace: WorkspaceExecutionContext): Promise<void> {
    if (this.dependencies.verifyOpenCode) return this.dependencies.verifyOpenCode(workspace)
    const launch = openCodeWorkspaceCommand(workspace, [])
    await verifyWorkspaceOpenCode(launch.command, launch.cwd, launch.environment)
  }

  async connect(input: AgentAccountConnect): Promise<WorkspaceAgentAccount> {
    return this.change(input, false)
  }

  async disconnect(target: AgentAccountTarget): Promise<WorkspaceAgentAccount> {
    return this.change(target, true)
  }

  private async change(input: AgentAccountTarget & Partial<AgentAccountConnect>, logout: boolean): Promise<WorkspaceAgentAccount> {
    const workspace = this.workspace(input)
    const target: AgentAccountTarget = { workspaceId: input.workspaceId, agentId: input.agentId }
    const key = this.key(target)
    if (target.agentId === 'codex' && !logout && !['apiKey', 'chatgpt'].includes(input.method ?? '')) throw new Error('Unsupported Codex login method')
    if (target.agentId === 'opencode' && !logout && input.method !== 'native') throw new Error('Use native OpenCode login')
    let release: () => void
    try { release = this.dependencies.acquire(target.workspaceId) }
    catch { return this.state(target, { status: 'busy', busy: true, message: 'Wait for active work or the pending account change in this workspace to finish.' }) }
    const operation: PendingAccount = { target, sessionId: randomUUID(), release, earlyNotifications: [] }
    this.pending.set(key, operation)
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1)
    this.publish(this.state(target, { status: 'pending', sessionId: operation.sessionId, message: logout ? 'Disconnecting account…' : 'Complete the native sign-in. New work in this workspace waits until it finishes or is cancelled.' }))
    operation.timer = setTimeout(() => { void this.finish(operation, 'Account connection timed out. Retry when ready.') }, 10 * 60_000)
    try {
      await this.dependencies.invalidate(target.workspaceId)
      if (operation.finishing) return operation.finishing
      if (target.agentId === 'codex') {
        operation.connection = this.connectCodex(workspace, (method, params) => {
          if (method !== 'account/login/completed' || this.pending.get(key) !== operation || operation.finishing) return
          if (!operation.loginId) { if (operation.earlyNotifications.length < 10) operation.earlyNotifications.push(params); return }
          if (params.loginId === operation.loginId) void this.finish(operation, params.success === true ? undefined : 'Sign-in failed or was cancelled. Retry the connection.')
        })
        void operation.connection.failure.catch(() => {
          if (!operation.finishing) void this.finish(operation, 'Native account connection stopped. Retry the connection.')
        })
        await this.initialize(operation.connection)
        if (operation.finishing) return operation.finishing
        if (logout) {
          await operation.connection.request('account/logout', {})
          return this.finish(operation)
        }
        const response = await operation.connection.request('account/login/start', input.method === 'apiKey'
          ? { type: 'apiKey', apiKey: input.apiKey ?? '' } : { type: 'chatgpt' })
        if (response.type === 'apiKey') return this.finish(operation)
        operation.loginId = response.loginId
        if (operation.finishing) return operation.finishing
        await this.dependencies.openBrowser(response.authUrl)
        const early = operation.earlyNotifications.find((item) => item.loginId === response.loginId)
        if (early) return this.finish(operation, early.success === true ? undefined : 'Sign-in failed or was cancelled. Retry the connection.')
        operation.earlyNotifications = []
      } else {
        await this.verify(workspace)
        if (operation.finishing) return operation.finishing
        const launch = openCodeWorkspaceCommand(workspace, ['auth', logout ? 'logout' : 'login'])
        const resolved = resolveCommand(launch.command)
        if (!resolved || resolved.viaShell) throw new Error('OpenCode requires a directly executable CLI')
        operation.terminalId = operation.sessionId
        this.terminals.create(operation.terminalId, launch.cwd, 80, 18, {
          command: resolved.command, args: [...resolved.prefixArgs, ...launch.args], environment: launch.environment
        })
        this.publish(this.state(target, { status: 'pending', sessionId: operation.sessionId, terminal: true,
          message: 'Choose a provider and follow its native prompts. Subscription methods depend on the provider. Finish or cancel before starting work in this workspace.' }))
      }
      return this.states.get(key)!
    } catch {
      return this.finish(operation, 'Account operation failed. Check the native agent installation and retry.')
    }
  }

  private finish(operation: PendingAccount, message?: string): Promise<WorkspaceAgentAccount> {
    if (operation.finishing) return operation.finishing
    operation.finishing = Promise.resolve().then(async () => {
      clearTimeout(operation.timer)
      let cleanedUp = false
      try {
        if (operation.connection) {
          if (message && operation.loginId) {
            try { await operation.connection.request('account/login/cancel', { loginId: operation.loginId }) } catch { /* Close below also terminates the native callback server. */ }
          }
          await operation.connection.close()
        }
        if (operation.terminalId) await this.terminals.dispose(operation.terminalId)
        await this.dependencies.invalidate(operation.target.workspaceId)
        cleanedUp = true
        let result: WorkspaceAgentAccount
        try { result = await this.read(operation.target) }
        catch { result = this.state(operation.target, { status: 'error', message: 'Could not refresh the native account. Retry status refresh.' }) }
        if (message) result = { ...result, status: message === 'Connection cancelled.' ? 'cancelled' : 'error', message }
        return this.publish(result)
      } catch {
        return this.publish(this.state(operation.target, { status: 'error', message: 'Could not finish account cleanup. Restart Anvil before retrying.' }))
      } finally {
        this.pending.delete(this.key(operation.target))
        // Failed process teardown must keep dispatch blocked until application restart.
        if (cleanedUp) operation.release()
      }
    })
    return operation.finishing
  }

  async cancel(target: AgentAccountTarget, sessionId: string): Promise<WorkspaceAgentAccount> {
    this.workspace(target)
    const operation = this.pending.get(this.key(target))
    if (!operation || operation.sessionId !== sessionId) return this.status(target)
    return this.finish(operation, 'Connection cancelled.')
  }

  terminal(target: AgentAccountTarget, sessionId: string, input?: { data?: string; cols?: number; rows?: number }): TerminalSnapshot {
    this.workspace(target)
    const operation = this.pending.get(this.key(target))
    if (!operation || operation.sessionId !== sessionId || !operation.terminalId || operation.finishing) return { data: '', sequence: 0 }
    if (input?.data) this.terminals.write(operation.terminalId, input.data)
    if (input?.cols && input.rows) this.terminals.resize(operation.terminalId, input.cols, input.rows)
    return this.terminals.snapshot(operation.terminalId)
  }

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = Promise.resolve().then(async () => {
      const operations = [...this.pending.values()].map((operation) => this.finish(operation, 'Connection cancelled.'))
      await Promise.allSettled(operations)
      await Promise.allSettled(this.reads.values())
      await this.terminals.close()
    })
    return this.closing
  }
}
