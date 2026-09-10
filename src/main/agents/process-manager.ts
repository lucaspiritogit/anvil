import type { IssueToolConnection } from '../issue-tools/server'
import type { WorkspaceExecutionContext } from './workspace-execution'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { resolveCommand } from './resolve'
import { closeAgentServer, killAgentServer } from './agent-server-process'
import { parseAgentLine } from './output'
import { getAgentAdapter } from './adapters'
import type { AgentExecutor, TaskResult, TaskSteeringInput } from './agent-executor'
import type {
  AgentDefinition,
  TaskImageAttachment,
  TaskEvent,
  TaskEventCategory,
  TaskUsage,
  StreamName
} from '../../shared/types'

const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g

export interface StartOptions {
  taskId: string
  workspace: WorkspaceExecutionContext
  issueId?: string
  agent: AgentDefinition
  prompt: string
  images?: TaskImageAttachment[]
  model?: string
  reasoningEffort?: string
  cwd: string
  projectPath?: string
  /** Resume this agent session instead of starting a fresh one. */
  resumeSessionId?: string
  /** Explicit recovery context for an interrupted task whose saved session is missing. */
  resumeFallbackPrompt?: string
  beforeDispatch?: () => void
  onStarted?: () => void
  onStartFailed?: (error: Error) => void
}

export interface ExitInfo {
  taskId: string
  code: number | null
  cancelled: boolean
  error?: string
  result?: TaskResult
}

export interface UsageInfo extends TaskUsage {
  taskId: string
}

export interface SessionInfo {
  taskId: string
  sessionId: string
}

const EMPTY_USAGE: TaskUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  totalTokens: 0,
  costUsd: null
}

function mergeUsage(current: TaskUsage, patch: Partial<TaskUsage>, mode: 'add' | 'set'): TaskUsage {
  const numberValue = (key: keyof Omit<TaskUsage, 'costUsd'>): number => {
    const value = patch[key]
    if (typeof value !== 'number') return current[key]
    return mode === 'add' ? current[key] + value : value
  }
  const costUsd =
    patch.costUsd === undefined || patch.costUsd === null
      ? current.costUsd
      : mode === 'add'
        ? (current.costUsd ?? 0) + patch.costUsd
        : patch.costUsd
  return {
    inputTokens: numberValue('inputTokens'),
    outputTokens: numberValue('outputTokens'),
    cachedTokens: numberValue('cachedTokens'),
    totalTokens: numberValue('totalTokens'),
    costUsd
  }
}

export function buildArgs(
  template: string[],
  prompt: string,
  model?: string,
  session?: string,
  reasoningEffort?: string
): string[] {
  const out: string[] = []
  for (const token of template) {
    if (token.includes('{{model}}')) {
      if (!model) {
        if (out.length && out[out.length - 1].startsWith('-')) out.pop()
        continue
      }
      out.push(token.replaceAll('{{model}}', model))
      continue
    }
    if (token.includes('{{session}}')) {
      if (!session) {
        if (out.length && out[out.length - 1].startsWith('-')) out.pop()
        continue
      }
      out.push(token.replaceAll('{{session}}', session))
      continue
    }
    if (token.includes('{{reasoningEffort}}')) {
      if (reasoningEffort === undefined) {
        if (out.length && out[out.length - 1].startsWith('-')) out.pop()
        continue
      }
      out.push(token.replaceAll('{{reasoningEffort}}', reasoningEffort))
      continue
    }
    out.push(token.replaceAll('{{prompt}}', prompt))
  }
  return out
}

/** Starts and cancels agent processes, captures their streams, and emits task events. */
export class AgentProcessManager extends EventEmitter {
  private procs = new Map<string, ChildProcess>()
  private cancelled = new Set<string>()
  private usage = new Map<string, TaskUsage>()
  private sessions = new Map<string, string>()
  private serverExecutions = new Map<string, AbortController>()
  private steeringExecutors = new Map<string, AgentExecutor>()
  private completions = new Set<Promise<void>>()
  private shutdown?: Promise<void>

  private readonly executionWorkspaces = new Map<string, string>()
  private readonly accountChanges = new Set<string>()

  isWorkspaceBusy(workspaceId: string): boolean {
    return [...this.executionWorkspaces].some(([taskId, owner]) => owner === workspaceId && this.isRunning(taskId))
  }

  acquireAccountChange(workspaceId: string): () => void {
    if (this.accountChanges.has(workspaceId) || this.isWorkspaceBusy(workspaceId)) {
      throw new Error('Wait for active work or the pending account change in this workspace to finish.')
    }
    this.accountChanges.add(workspaceId)
    return () => { this.accountChanges.delete(workspaceId) }
  }

  async invalidateWorkspaceClients(workspaceId: string): Promise<void> {
    if (this.isWorkspaceBusy(workspaceId)) throw new Error('Workspace has active work')
    const closing: Promise<void>[] = []
    for (const [key, client] of this.clients) {
      if (JSON.parse(key)[0] !== workspaceId) continue
      this.clients.delete(key)
      if (client.close) closing.push(client.close())
    }
    await Promise.all(closing)
  }

  private requireAccountReady(workspaceId: string): void {
    if (this.accountChanges.has(workspaceId)) throw new Error('Finish or cancel the pending account change in this workspace before starting work.')
  }

  private readonly clients = new Map<string, AgentExecutor>()

  constructor(
    private readonly openCodeClient?: AgentExecutor,
    private readonly codexClient?: AgentExecutor,
    private readonly createExecutor = (agentId: string, workspace: WorkspaceExecutionContext): AgentExecutor => getAgentAdapter(agentId).createExecutor(workspace),
    private readonly taskWorkspace?: (taskId: string) => WorkspaceExecutionContext,
    private readonly openIssueTools?: (taskId: string) => Promise<IssueToolConnection>
  ) {
    super()
  }

  private executor(agentId: string, workspace: WorkspaceExecutionContext): AgentExecutor {
    const key = JSON.stringify([workspace.workspaceId, agentId])
    let client = this.clients.get(key)
    if (!client) {
      client = (agentId === 'codex' ? this.codexClient : this.openCodeClient) ?? this.createExecutor(agentId, workspace)
      this.clients.set(key, client)
    }
    return client
  }

  /** A fresh, read-only turn for metadata, separate from the task's session and lifecycle. */
  async generateText(options: Pick<StartOptions, 'agent' | 'prompt' | 'cwd' | 'model' | 'reasoningEffort' | 'workspace'>): Promise<string> {
    if (this.shutdown) throw new Error('Agent processes are shutting down')
    this.requireAccountReady(options.workspace.workspaceId)
    const client = ['codex', 'opencode'].includes(options.agent.id) ? this.executor(options.agent.id, options.workspace) : undefined
    if (!client) throw new Error('This agent does not support PR drafting')
    const taskId = `pr-draft-${randomUUID()}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 120_000)
    this.executionWorkspaces.set(taskId, options.workspace.workspaceId)
    this.serverExecutions.set(taskId, controller)
    const { agent: _agent, ...input } = options
    const execution = Promise.resolve().then(() => client.execute({ ...input, taskId, readOnly: true, signal: controller.signal }, () => {}))
    const completion = execution.then(() => {}, () => {})
    this.completions.add(completion)
    try {
      const result = await execution
      if (result.status !== 'succeeded') throw new Error(result.error ?? 'PR drafting was cancelled or timed out.')
      const text = result.output.trim()
      if (!text) throw new Error('The agent returned an empty draft.')
      return text
    } finally {
      clearTimeout(timer)
      this.serverExecutions.delete(taskId)
      this.executionWorkspaces.delete(taskId)
      this.completions.delete(completion)
    }
  }

  isRunning(taskId: string): boolean {
    return this.procs.has(taskId) || this.serverExecutions.has(taskId)
  }

  async steer(input: TaskSteeringInput): Promise<void> {
    if (this.shutdown) throw new Error('Agent processes are shutting down')
    const controller = this.serverExecutions.get(input.taskId)
    if (!controller || controller.signal.aborted) throw new Error('This task has no active agent turn')
    const client = this.steeringExecutors.get(input.taskId)
    if (!client?.steer) throw new Error('This agent does not support steering')
    await client.steer(input)
  }

  /** Resolves only after the transport accepts a resumed turn. */
  startResumed(opts: StartOptions): Promise<void> {
    return new Promise((resolve, reject) => this.start({ ...opts, onStarted: resolve, onStartFailed: reject }))
  }

  private startServer(opts: StartOptions, client: AgentExecutor): void {
    const { issueId } = opts
    const controller = new AbortController()
    this.executionWorkspaces.set(opts.taskId, opts.workspace.workspaceId)
    this.serverExecutions.set(opts.taskId, controller)
    if (opts.agent.supportsSteering && client.steer) this.steeringExecutors.set(opts.taskId, client)
    let started = false
    const onStarted = () => {
      if (started) return
      started = true
      opts.onStarted?.()
    }
    const { agent: _agent, onStartFailed: _onStartFailed, ...input } = opts
    const completion = (async () => {
      const issueTools = await this.openIssueTools?.(opts.taskId)
      try {
        controller.signal.throwIfAborted()
        return await client.execute({ ...input, issueTools, onStarted, signal: controller.signal }, (event) => {
          switch (event.type) {
            case 'output':
              this.emit('event', { ...event.event, issueId } satisfies TaskEvent)
              break
            case 'session':
              this.emit('session', { taskId: event.taskId, sessionId: event.sessionId } satisfies SessionInfo)
              break
            case 'usage':
              this.emit('usage', { taskId: event.taskId, ...event.usage } satisfies UsageInfo)
              break
          }
        })
      } finally {
        issueTools?.close()
      }
    })().then((result) => {
      this.steeringExecutors.delete(opts.taskId)
      this.serverExecutions.delete(opts.taskId)
      this.executionWorkspaces.delete(opts.taskId)
      const cancelled = this.cancelled.delete(opts.taskId)
      if (!started && opts.onStartFailed) {
        opts.onStartFailed(new Error(result.error ?? 'Agent stopped before accepting the turn'))
        return
      }
      this.emit('exit', {
        taskId: opts.taskId,
        code: result.status === 'succeeded' ? 0 : result.status === 'cancelled' ? null : 1,
        cancelled, error: result.error, result
      } satisfies ExitInfo)
    }, (failure: unknown) => {
      this.steeringExecutors.delete(opts.taskId)
      this.serverExecutions.delete(opts.taskId)
      this.executionWorkspaces.delete(opts.taskId)
      const error = failure instanceof Error ? failure.message : String(failure)
      this.emitSystem(opts.taskId, error, true, issueId)
      const cancelled = this.cancelled.delete(opts.taskId)
      if (!started && opts.onStartFailed) {
        opts.onStartFailed(new Error(error))
        return
      }
      this.emit('exit', { taskId: opts.taskId, code: null, cancelled, error } satisfies ExitInfo)
    })
    this.completions.add(completion)
    void completion.finally(() => this.completions.delete(completion))
  }

  private emitLine(
    taskId: string,
    stream: StreamName,
    text: string,
    category: TaskEventCategory,
    issueId?: string
  ): void {
    const event: TaskEvent = {
      id: randomUUID(),
      taskId,
      issueId,
      ts: Date.now(),
      stream,
      kind: 'output',
      category,
      text: text.replace(ANSI, '').replace(/\r$/, '')
    }
    this.emit('event', event)
  }

  /** Anvil's own commentary about the process, not the agent's output. */
  private emitSystem(taskId: string, text: string, failed = false, issueId?: string): void {
    this.emitLine(taskId, 'system', text, failed ? 'error' : 'system', issueId)
  }

  private updateUsage(taskId: string, patch: Partial<TaskUsage>, mode: 'add' | 'set'): void {
    const next = mergeUsage(this.usage.get(taskId) ?? EMPTY_USAGE, patch, mode)
    this.usage.set(taskId, next)
    this.emit('usage', { taskId, ...next } satisfies UsageInfo)
  }

  private handleLine(
    taskId: string,
    agent: AgentDefinition,
    stream: StreamName,
    line: string,
    issueId?: string
  ): void {
    // Everything on stderr is an error, whatever the agent's protocol is.
    if (stream === 'stderr') {
      this.emitLine(taskId, 'stderr', line, 'error', issueId)
      return
    }
    if (!agent.outputProtocol) {
      this.emitLine(taskId, stream, line, 'message', issueId)
      return
    }
    const parsed = parseAgentLine(agent.outputProtocol, line)
    if (parsed.sessionId && this.sessions.get(taskId) !== parsed.sessionId) {
      this.sessions.set(taskId, parsed.sessionId)
      this.emit('session', { taskId, sessionId: parsed.sessionId } satisfies SessionInfo)
    }
    if (parsed.usage && parsed.usageMode) {
      this.updateUsage(taskId, parsed.usage, parsed.usageMode)
    }
    for (const part of parsed.parts) {
      for (const text of part.text.split(/\r?\n/)) {
        this.emitLine(taskId, part.stream, text, part.category, issueId)
      }
    }
  }

  private pipe(
    taskId: string,
    agent: AgentDefinition,
    stream: StreamName,
    src: NodeJS.ReadableStream,
    issueId?: string
  ): () => void {
    let buffer = ''
    src.setEncoding('utf8')
    src.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) this.handleLine(taskId, agent, stream, line, issueId)
    })
    return () => {
      if (buffer.trim()) this.handleLine(taskId, agent, stream, buffer, issueId)
      buffer = ''
    }
  }

  start(opts: StartOptions): void {
    if (this.shutdown) throw new Error('Agent processes are shutting down')
    // Copy the turn options before callbacks or later issue transitions can mutate them.
    opts = { ...opts }
    if (this.taskWorkspace) {
      const owner = this.taskWorkspace(opts.taskId)
      if (owner.workspaceId !== opts.workspace.workspaceId) throw new Error('Task workspace does not match its persisted owner')
    }
    if (opts.images?.length && !['acp', 'codex-app-server'].includes(opts.agent.executionProtocol ?? '')) {
      throw new Error(`${opts.agent.label} does not support image attachments. Choose Codex or OpenCode with an image-capable model.`)
    }
    this.requireAccountReady(opts.workspace.workspaceId)
    opts.beforeDispatch?.()
    if (this.isRunning(opts.taskId)) throw new Error('This task is already running')
    if (opts.agent.executionProtocol === 'acp') {
      this.startServer(opts, this.executor('opencode', opts.workspace))
      return
    }
    if (opts.agent.executionProtocol === 'codex-app-server') {
      this.startServer(opts, this.executor('codex', opts.workspace))
      return
    }
    const { taskId, issueId, agent, prompt, model, reasoningEffort, cwd, resumeSessionId } = opts
    this.usage.set(taskId, {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      costUsd: null
    })

    const resolved = resolveCommand(agent.command)
    if (!resolved) {
      this.usage.delete(taskId)
      this.emitSystem(taskId, `Command not found on PATH: "${agent.command}"`, true, issueId)
      if (opts.onStartFailed) {
        opts.onStartFailed(new Error(`"${agent.command}" is not installed or not on PATH`))
        return
      }
      this.emit('exit', {
        taskId,
        code: null,
        cancelled: false,
        error: `"${agent.command}" is not installed or not on PATH`
      } satisfies ExitInfo)
      return
    }

    const resuming = Boolean(resumeSessionId && agent.resumeArgs)
    const template = resuming ? agent.resumeArgs! : agent.args
    const agentArgs = buildArgs(template, prompt, model, resumeSessionId, reasoningEffort)
    const args = [...resolved.prefixArgs, ...agentArgs]

    this.emitSystem(taskId, `$ ${agent.command} ${agentArgs.join(' ')}`, false, issueId)
    this.emitSystem(taskId, `cwd: ${cwd}`, false, issueId)

    let child: ChildProcess
    try {
      child = spawn(resolved.command, args, {
        cwd,
        shell: resolved.viaShell,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        // spawn() chdirs the child but leaves PWD pointing at Anvil's own launch
        // directory. An agent that trusts $PWD over getcwd() would write its
        // files there instead of into the task directory.
        env: { ...opts.workspace.environment, PWD: cwd, NO_COLOR: '1', FORCE_COLOR: '0' }
      })
    } catch (err) {
      this.usage.delete(taskId)
      const message = err instanceof Error ? err.message : String(err)
      this.emitSystem(taskId, `Failed to spawn: ${message}`, true, issueId)
      if (opts.onStartFailed) {
        opts.onStartFailed(new Error(message))
        return
      }
      this.emit('exit', { taskId, code: null, cancelled: false, error: message } satisfies ExitInfo)
      return
    }

    let started = false
    let startupError: Error | undefined
    child.once('spawn', () => {
      started = true
      opts.onStarted?.()
    })
    this.executionWorkspaces.set(taskId, opts.workspace.workspaceId)
    this.procs.set(taskId, child)

    const flushOut = this.pipe(taskId, agent, 'stdout', child.stdout!, issueId)
    const flushErr = this.pipe(taskId, agent, 'stderr', child.stderr!, issueId)

    child.on('error', (err) => {
      startupError = err
      this.emitSystem(taskId, `Process error: ${err.message}`, true, issueId)
    })

    child.on('close', (code) => {
      flushOut()
      flushErr()
      this.procs.delete(taskId)
      this.executionWorkspaces.delete(taskId)
      this.usage.delete(taskId)
      this.sessions.delete(taskId)
      const cancelled = this.cancelled.delete(taskId)
      this.emitSystem(taskId, cancelled ? 'Task cancelled.' : `Process exited with code ${code}.`, false, issueId)
      if (!started && opts.onStartFailed) {
        opts.onStartFailed(startupError ?? new Error('Agent stopped before starting'))
        return
      }
      this.emit('exit', { taskId, code, cancelled } satisfies ExitInfo)
    })
  }

  cancel(taskId: string): boolean {
    const execution = this.serverExecutions.get(taskId)
    if (execution) {
      this.cancelled.add(taskId)
      execution.abort()
      return true
    }
    const child = this.procs.get(taskId)
    if (!child?.pid) return false
    this.cancelled.add(taskId)

    killAgentServer(child)
    return true
  }

  cancelAll(): void {
    for (const taskId of [...this.procs.keys(), ...this.serverExecutions.keys()]) this.cancel(taskId)
  }

  /** Reject new work, cancel active turns, and await all owned server processes. */
  close(): Promise<void> {
    if (this.shutdown) return this.shutdown
    this.shutdown = Promise.resolve().then(async () => {
      this.emit('closing')
      const processes = [...this.procs.entries()].map(([taskId, child]) => {
        const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
        return closeAgentServer(child, closed)
      })
      for (const execution of this.serverExecutions.values()) execution.abort()
      await Promise.all([
        ...processes, ...this.completions,
        ...[...new Set([...this.clients.values(), this.openCodeClient, this.codexClient])].map((client) => client?.close?.())
      ])
    })
    return this.shutdown
  }
}
