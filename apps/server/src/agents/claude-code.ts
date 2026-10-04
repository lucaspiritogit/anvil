import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { ProviderModelList } from '@anvil/protocol/types'
import { canonicalReasoningOptions } from '@anvil/protocol/reasoning-levels'
import type { AgentExecutor, TaskEvent, TaskInput, TaskResult } from './agent-executor'
import type { WorkspaceExecutionContext } from './workspace-execution'
import { retryableAgentFailure } from './agent-failure'
import { ClaudeCodeConnection, type ClaudeCodeConnectionOptions, type ClaudeCodeConnectionHandlers, type ClaudeObject } from './claude-code-connection'
import { ClaudeCodeOutput, claudeObject } from './claude-code-output'

interface ClaudeCodeTransport {
  initialize(): Promise<ClaudeObject>
  request(subtype: string, params?: ClaudeObject): Promise<ClaudeObject>
  send(message: ClaudeObject): Promise<void>
  close(): Promise<void>
  readonly failure: Promise<never>
}

export interface ClaudeCodeOptions {
  workspace: WorkspaceExecutionContext
  command?: string
  args?: string[]
  requestTimeoutMs?: number
  connection?: (options: ClaudeCodeConnectionOptions, handlers: ClaudeCodeConnectionHandlers) => ClaudeCodeTransport
}

interface ClaudeExecution {
  taskId: string
  sessionId?: string
  connection?: ClaudeCodeTransport
  cancel(): void
  completion: Promise<void>
}

function failureText(result: ClaudeObject): string {
  if (Array.isArray(result.errors)) {
    const errors = result.errors.filter((error): error is string => typeof error === 'string')
    if (errors.length > 0) return errors.join('\n')
  }
  if (typeof result.result === 'string' && result.result) return result.result
  return `Claude stopped with reason: ${String(result.terminal_reason ?? result.subtype ?? 'unknown')}`
}

function missingSession(message: string): boolean {
  return /^(?:No conversation found with session ID:|No session found with session ID:|Session .* (?:not found|does not exist)\.?$)/i.test(message)
}

function requireSubscription(initialized: ClaudeObject, usage: ClaudeObject): void {
  const account = claudeObject(initialized.account)
  const subscriptionType = usage.subscription_type ?? account.subscriptionType
  const subscription = typeof subscriptionType === 'string' && ['pro', 'max', 'team', 'enterprise'].includes(subscriptionType)
  if (account.apiProvider !== 'firstParty' ||
    account.tokenSource !== undefined && account.tokenSource !== 'claude.ai' ||
    account.tokenSource !== 'claude.ai' && !subscription ||
    account.apiKeySource !== undefined && account.apiKeySource !== 'none') {
    throw new Error('Claude subscription is not authenticated for this workspace. Connect a Claude subscription account and retry.')
  }
}

function terminalRetry(result: ClaudeObject, message: string): TaskResult['retry'] {
  if (['blocking_limit', 'rapid_refill_breaker', 'budget_exhausted'].includes(String(result.terminal_reason))) return undefined
  return retryableAgentFailure({ message, statusCode: result.api_error_status })
}

export class ClaudeCodeClient implements AgentExecutor {
  private readonly executions = new Set<ClaudeExecution>()
  private readonly probes = new Set<ClaudeCodeTransport>()
  private closed = false
  private closing?: Promise<void>

  constructor(private readonly options: ClaudeCodeOptions) {}

  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    const executions = [...this.executions]
    for (const execution of executions) execution.cancel()
    this.closing = Promise.all([
      ...executions.map((execution) => execution.completion),
      ...executions.flatMap((execution) => execution.connection ? [execution.connection.close()] : []),
      ...[...this.probes].map((connection) => connection.close())
    ]).then(() => {})
    return this.closing
  }

  async listModels(cwd = this.options.workspace.home, signal?: AbortSignal): Promise<Pick<ProviderModelList, 'models' | 'displayByModel' | 'reasoningByModel' | 'capabilitiesByModel'>> {
    if (this.closed) throw new Error('Claude is shutting down')
    signal?.throwIfAborted()
    const connection = this.createConnection({ cwd, noSessionPersistence: true, readOnly: true, safeMode: true }, { message: () => {} })
    this.probes.add(connection)
    const abort = (): void => { void connection.close().catch(() => {}) }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const initialized = await Promise.race([connection.initialize(), connection.failure])
      signal?.throwIfAborted()
      const usage = await Promise.race([connection.request('get_usage', { skip_behaviors: true }), connection.failure])
      signal?.throwIfAborted()
      requireSubscription(initialized, usage)
      if (!Array.isArray(initialized.models)) throw new Error('Claude did not report its available models')
      const models: string[] = []
      const displayByModel: NonNullable<ProviderModelList['displayByModel']> = {}
      const reasoningByModel: NonNullable<ProviderModelList['reasoningByModel']> = {}
      const capabilitiesByModel: NonNullable<ProviderModelList['capabilitiesByModel']> = {}
      for (const value of initialized.models) {
        const model = claudeObject(value)
        if (model.disabled === true || typeof model.value !== 'string' || models.includes(model.value)) continue
        models.push(model.value)
        displayByModel[model.value] = {
          ...(typeof model.displayName === 'string' && model.displayName ? { name: model.displayName } : {}),
          ...(typeof model.resolvedModel === 'string' && model.resolvedModel ? { resolvedModel: model.resolvedModel } : {})
        }
        if (Array.isArray(model.supportedEffortLevels)) {
          const levels = model.supportedEffortLevels.filter((level): level is string => typeof level === 'string')
          reasoningByModel[model.value] = { options: canonicalReasoningOptions(levels) }
        } else if (model.supportsEffort === false) {
          reasoningByModel[model.value] = { options: [] }
        }
        capabilitiesByModel[model.value] = { imageInput: true }
      }
      return { models, displayByModel, reasoningByModel, capabilitiesByModel }
    } finally {
      signal?.removeEventListener('abort', abort)
      this.probes.delete(connection)
      await connection.close()
    }
  }

  compact(input: TaskInput, onEvent: (event: TaskEvent) => void): Promise<TaskResult> {
    if (!input.resumeSessionId) throw new Error('Compaction requires a saved Claude session')
    return this.execute({ ...input, compactOnly: true, images: undefined, resumeFallbackPrompt: undefined }, onEvent)
  }

  async execute(input: TaskInput, onEvent: (event: TaskEvent) => void): Promise<TaskResult> {
    if (this.closed) return { taskId: input.taskId, issueId: input.issueId, status: 'failed', output: '', changedFiles: [], error: 'Claude is shutting down' }
    if ([...this.executions].some((execution) => execution.taskId === input.taskId ||
      input.resumeSessionId !== undefined && execution.sessionId === input.resumeSessionId)) {
      return { taskId: input.taskId, issueId: input.issueId, status: 'failed', output: '', changedFiles: [], error: 'This Claude session already has an active turn' }
    }
    const controller = new AbortController()
    const abort = (): void => { controller.abort() }
    input.signal?.addEventListener('abort', abort, { once: true })
    if (input.signal?.aborted) controller.abort()
    let finish!: () => void
    const completion = new Promise<void>((resolve) => { finish = resolve })
    const execution: ClaudeExecution = { taskId: input.taskId, sessionId: input.resumeSessionId, cancel: abort, completion }
    this.executions.add(execution)
    try {
      return await this.run(input, onEvent, controller.signal, execution)
    } finally {
      input.signal?.removeEventListener('abort', abort)
      this.executions.delete(execution)
      finish()
    }
  }

  private createConnection(options: Omit<ClaudeCodeConnectionOptions, 'workspace'>, handlers: ClaudeCodeConnectionHandlers): ClaudeCodeTransport {
    const configured: ClaudeCodeConnectionOptions = {
      command: this.options.command, args: this.options.args, requestTimeoutMs: this.options.requestTimeoutMs,
      ...options, workspace: this.options.workspace
    }
    return this.options.connection ? this.options.connection(configured, handlers) : new ClaudeCodeConnection(configured, handlers)
  }

  private async run(input: TaskInput, onEvent: (event: TaskEvent) => void, signal: AbortSignal, execution: ClaudeExecution): Promise<TaskResult> {
    let output = new ClaudeCodeOutput(input, onEvent)
    let sessionId = input.resumeSessionId
    let prompt = input.prompt
    let recovered = false
    let dispatched = false
    let terminal: ClaudeObject | undefined
    let status: TaskResult['status'] = 'failed'
    let error: string | undefined
    let retry: TaskResult['retry']
    let started = false
    let compactSucceeded = false
    let compactError: string | undefined
    const startedTurn = (): void => {
      if (started || !dispatched) return
      started = true
      input.onStarted?.()
    }
    while (true) {
      let recoverNext = false
      let connection: ClaudeCodeTransport | undefined
      let resolveResult!: (result: ClaudeObject) => void
      let rejectInterrupted!: (error: Error) => void
      let startupFailure: string | undefined
      const result = new Promise<ClaudeObject>((resolve) => { resolveResult = resolve })
      const interrupted = new Promise<never>((_, reject) => { rejectInterrupted = reject })
      void interrupted.catch(() => {})
      const request = <Response>(promise: Promise<Response>): Promise<Response> => Promise.race([promise, interrupted, connection!.failure])
      const cancel = (): void => {
        rejectInterrupted(new Error('Task cancelled.'))
        if (!connection) return
        void connection.request('interrupt', { cancel_queued: true }).catch(() => {})
        void connection.close().catch(() => {})
      }
      signal.addEventListener('abort', cancel, { once: true })
      const userMessageId = randomUUID()
      try {
        signal.throwIfAborted()
        if (!isAbsolute(input.cwd)) throw new Error('Claude requires an absolute working directory')
        if (input.workspace.workspaceId !== this.options.workspace.workspaceId) throw new Error('Claude execution workspace does not match its owner')
        connection = this.createConnection({ cwd: input.cwd, model: input.model, reasoningEffort: input.reasoningEffort,
          resumeSessionId: sessionId, mcpServers: input.mcpServers, readOnly: input.readOnly,
          noSessionPersistence: input.readOnly, safeMode: input.readOnly }, {
          message: (message) => {
            if (message.type === 'result') {
              terminal = message
              if (dispatched) startedTurn()
              resolveResult(message)
            }
            if (typeof message.session_id === 'string' && message.session_id && message.session_id !== sessionId) {
              sessionId = message.session_id
              execution.sessionId = sessionId
              if (!input.readOnly) onEvent({ type: 'session', taskId: input.taskId, sessionId })
            }
            if (!dispatched) return
            if (message.type === 'command_lifecycle' && message.command_uuid === userMessageId && ['queued', 'started'].includes(String(message.state))) startedTurn()
            if (message.type === 'assistant' || message.type === 'stream_event' || message.type === 'system' && message.subtype === 'init') startedTurn()
            if (message.type === 'system' && message.subtype === 'status') {
              if (message.compact_result === 'success') compactSucceeded = true
              if (message.compact_result === 'failed') compactError = typeof message.compact_error === 'string' ? message.compact_error : 'Claude context compaction failed'
            }
            if (message.type === 'system' && message.subtype === 'compact_boundary') compactSucceeded = true
            output.message(message)
          },
          diagnostic: (line) => {
            if (!dispatched && missingSession(line.trim())) startupFailure = line.trim()
            output.line(line, 'error', 'stderr')
          }
        })
        execution.connection = connection
        const initializationFailure = result.then((message) => { throw new Error(failureText(message)) })
        const initialized = await request(Promise.race([connection.initialize(), initializationFailure]))
        if (terminal) throw new Error(failureText(terminal))
        const baseline = await request(connection.request('get_usage', { skip_behaviors: true }))
        requireSubscription(initialized, baseline)
        output.setUsageBaseline(claudeObject(baseline.session).model_usage)
        await this.requireMcp(connection, input, signal, request)
        signal.throwIfAborted()
        input.beforeDispatch?.()
        dispatched = true
        await request(connection.send({ type: 'user', uuid: userMessageId, session_id: sessionId ?? '',
          parent_tool_use_id: null, origin: { kind: 'human' },
          message: { role: 'user', content: input.compactOnly ? '/compact' : [
            { type: 'text', text: /^\s*\//.test(prompt) ? `User request:\n\n${prompt}` : prompt },
            ...(input.images ?? []).map((image) => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: Buffer.from(image.bytes).toString('base64') } }))
          ] }
        }))
        terminal = await request(result)
        if (input.compactOnly && (compactError || !compactSucceeded)) {
          throw new Error(compactError ?? 'Claude did not confirm context compaction')
        }
        status = terminal.subtype === 'success' && terminal.is_error !== true ? 'succeeded' : 'failed'
        if (status === 'failed') {
          error = failureText(terminal)
          retry = terminalRetry(terminal, error)
        }
        try {
          const context = await request(connection.request('get_context_usage', { detail: 'summary' }))
          output.updateContext(context)
        } catch {
          if (input.compactOnly) onEvent({ type: 'context', taskId: input.taskId, contextUsed: null, contextSize: null })
        }
      } catch (failure) {
        status = signal.aborted ? 'cancelled' : 'failed'
        if (status === 'failed') {
          const failedTerminal = terminal && (terminal.subtype !== 'success' || terminal.is_error === true) ? terminal : undefined
          error = failedTerminal ? failureText(failedTerminal) : startupFailure ?? (failure instanceof Error ? failure.message : String(failure))
          if (!dispatched && !recovered && !input.readOnly && !input.compactOnly && input.resumeSessionId && input.resumeFallbackPrompt && missingSession(error)) {
            recovered = true
            sessionId = undefined
            execution.sessionId = undefined
            prompt = input.resumeFallbackPrompt
            terminal = undefined
            error = undefined
            retry = undefined
            output.line('The saved Claude session is unavailable. Starting a new session from the saved task plan and branch. Previous conversation history was not restored.', 'system', 'system')
            output = new ClaudeCodeOutput({ ...input, resumeSessionId: undefined }, onEvent)
            recoverNext = true
          } else {
            retry = failedTerminal ? terminalRetry(failedTerminal, error) : startupFailure ? undefined : retryableAgentFailure(failure)
          }
        }
      } finally {
        signal.removeEventListener('abort', cancel)
        try {
          await connection?.close()
        } catch (failure) {
          status = signal.aborted ? 'cancelled' : 'failed'
          error = `${error ? `${error} ` : ''}Could not stop Claude: ${failure instanceof Error ? failure.message : String(failure)}`
          retry = undefined
          recoverNext = false
        }
        execution.connection = undefined
      }
      if (recoverNext) continue
      break
    }
    if (signal.aborted) status = 'cancelled'
    output.flush()
    if (error && status !== 'cancelled') output.line(error, 'error', 'system')
    output.line(status === 'cancelled' ? 'Task cancelled.' : `Claude turn ${status}.`, 'system', 'system')
    return { taskId: input.taskId, issueId: input.issueId, status, sessionId, output: output.output,
      changedFiles: [...output.changedFiles], usage: output.usage, stopReason: typeof terminal?.stop_reason === 'string' ? terminal.stop_reason : undefined,
      error: status === 'cancelled' ? undefined : error, retry: status === 'cancelled' ? undefined : retry }
  }

  private async requireMcp(connection: ClaudeCodeTransport, input: TaskInput, signal: AbortSignal,
    request: <Response>(promise: Promise<Response>) => Promise<Response>): Promise<void> {
    const required = input.readOnly ? [] : (input.mcpServers ?? []).filter((server) => server.required)
    if (required.length === 0) return
    const deadline = Date.now() + (this.options.requestTimeoutMs ?? 20_000)
    while (true) {
      signal.throwIfAborted()
      const status = await request(connection.request('mcp_status'))
      const servers = Array.isArray(status.mcpServers) ? status.mcpServers.map(claudeObject) : []
      let pending = false
      for (const server of required) {
        const current = servers.find((entry) => entry.name === server.name)
        if (current?.status === 'connected') continue
        if (current?.status === 'pending' && Date.now() < deadline) {
          pending = true
          continue
        }
        throw new Error(`Claude could not connect to required Anvil tools: ${server.name}`)
      }
      if (!pending) return
      await request(new Promise<void>((resolve) => { setTimeout(resolve, 50) }))
    }
  }
}
