import { isAbsolute } from 'node:path'
import { retryableAgentFailure } from './agent-failure'
import type { AgentExecutor, TaskEvent, TaskInput, TaskResult, TaskSteeringInput } from './agent-executor'
import { CodexAppServerConnection, CodexRpcError, type CodexAppServerOptions, type ConnectionHandlers } from './codex-app-server-connection'
import { CodexAppServerOutput } from './codex-app-server-output'
import { codexTurn, type CodexAppServerRequests, type CodexObject, type CodexThreadOptions, type CodexTurn } from './codex-app-server-protocol'
import { LazyAgentServer } from './lazy-agent-server'
import { codexSandboxPolicy } from './codex-sandbox'
import type { ProviderModelList, ModelReasoningCapabilities } from '../../shared/types'

interface CodexExecution extends ConnectionHandlers {
  taskId: string
  steer(input: TaskSteeringInput): Promise<void>
  server(): CodexAppServerConnection | undefined
  thread(): string | undefined
}

/** One lazy app-server with thread-scoped routing. No ACP messages are used. */
export class CodexAppServerClient implements AgentExecutor {
  private readonly server = new LazyAgentServer<CodexAppServerConnection>()
  private readonly executions = new Set<CodexExecution>()

  constructor(private readonly options: CodexAppServerOptions) {}

  close(): Promise<void> {
    return this.server.close()
  }

  async steer(input: TaskSteeringInput): Promise<void> {
    if (!input.message.trim()) throw new Error('A steering message needs some text')
    const execution = [...this.executions].find((entry) => entry.taskId === input.taskId)
    if (!execution) throw new Error('This task has no active Codex turn')
    await execution.steer(input)
  }

  private connection(onCreate?: (server: CodexAppServerConnection) => void): Promise<CodexAppServerConnection> {
    return this.server.get(() => {
      // A shared server outlives task worktrees. Recreating a deleted path does
      // not repair a process whose OS cwd still points to the removed directory.
      const server: CodexAppServerConnection = new CodexAppServerConnection(this.options.workspace.home, this.options, {
        notification: (method, params) => {
          for (const active of this.executions) if (active.server() === server) active.notification(method, params)
        },
        serverRequest: (method, params) => {
          const active = [...this.executions].find((entry) => entry.server() === server && entry.thread() === params.threadId)
          if (active) return active.serverRequest(method, params)
          switch (method) {
            case 'item/commandExecution/requestApproval':
            case 'item/fileChange/requestApproval': return { decision: 'cancel' }
            case 'item/permissions/requestApproval': return { permissions: {}, scope: 'turn' }
            case 'mcpServer/elicitation/request': return { action: 'cancel', content: null }
            case 'item/tool/requestUserInput': return { answers: {} }
            default: throw new CodexRpcError(-32601, `Anvil does not implement Codex server request: ${method}`)
          }
        },
        diagnostic: (text) => {
          for (const active of this.executions) if (active.server() === server) active.diagnostic(text)
        }
      })
      onCreate?.(server)
      return server
    }, async (server) => {
      try {
        await server.request('initialize', { clientInfo: { name: 'anvil', title: 'Anvil', version: '0.1.0' } })
        server.initialized()
        const response = await server.request('config/read', { includeLayers: false })
        if (response.config.cli_auth_credentials_store !== 'file') {
          throw new Error('Codex did not confirm cli_auth_credentials_store="file"')
        }
      } catch (failure) {
        throw new Error(`Could not initialize isolated Codex for workspace ${this.options.workspace.workspaceId}. Anvil requires cli_auth_credentials_store="file". Update Codex if this setting or config/read is unsupported; if an administrator enforces another credential store, ask them to allow file storage. ${failure instanceof Error ? failure.message : String(failure)}`)
      }
    })
  }

  async readAccount(): Promise<CodexAppServerRequests['account/read']['result']> {
    const connection = await this.connection()
    return this.readConnectionAccount(connection)
  }

  private authenticationError(): Error {
    return new Error(`Codex is not authenticated for workspace ${this.options.workspace.workspaceId}. Sign in to Codex for this workspace using CODEX_HOME=${this.options.workspace.codexHome} and cli_auth_credentials_store="file", then retry.`)
  }

  private async readConnectionAccount(connection: CodexAppServerConnection): Promise<CodexAppServerRequests['account/read']['result']> {
    const response = await connection.request('account/read', { refreshToken: false })
    if (response.requiresOpenaiAuth && response.account === null) {
      // Codex caches authentication in the process. A retry after an external
      // profile login must load the newly saved credentials in a fresh server.
      connection.fail(this.authenticationError())
    }
    return response
  }

  private async requireAuthentication(connection: CodexAppServerConnection): Promise<void> {
    const response = await this.readConnectionAccount(connection)
    if (response.requiresOpenaiAuth && response.account === null) {
      throw this.authenticationError()
    }
  }

  async listModels(_cwd: string): Promise<Pick<ProviderModelList, 'models' | 'reasoningByModel'>> {
    const connection = await this.connection()
    await this.requireAuthentication(connection)
    const reasoning = new Map<string, ModelReasoningCapabilities>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await connection.request('model/list', { cursor })
      for (const model of page.data) {
        reasoning.set(model.model, {
          options: model.supportedReasoningEfforts.map((option) => ({ id: option.reasoningEffort, label: option.description })),
          default: model.defaultReasoningEffort
        })
      }
      cursor = page.nextCursor ?? undefined
      if (cursor !== undefined) {
        if (cursors.has(cursor)) throw new Error('Codex model/list repeated a pagination cursor')
        cursors.add(cursor)
      }
    } while (cursor !== undefined)
    return { models: [...reasoning.keys()], reasoningByModel: Object.fromEntries(reasoning) }
  }

  async execute(input: TaskInput, onEvent: (event: TaskEvent) => void): Promise<TaskResult> {
    let output = new CodexAppServerOutput(input, onEvent)
    let connection: CodexAppServerConnection | undefined
    let threadId = input.resumeSessionId
    let turnId: string | undefined
    let startingTurn = false
    let finished = false
    let status: TaskResult['status'] = 'failed'
    let stopReason: string | undefined
    let error: string | undefined
    let retry: TaskResult['retry']
    let cancelTimer: ReturnType<typeof setTimeout> | undefined
    const queued: Array<{ method: string; params: CodexObject }> = []
    let resolveTurn!: (turn: CodexTurn) => void
    const completed = new Promise<CodexTurn>((resolve) => { resolveTurn = resolve })
    let rejectExecution!: (error: Error) => void
    const interrupted = new Promise<never>((_, reject) => { rejectExecution = reject })
    void interrupted.catch(() => {})
    const request = <Response>(promise: Promise<Response>): Promise<Response> => Promise.race([promise, interrupted])

    const interrupt = (): void => {
      if (connection && threadId && turnId && !finished) {
        void connection.request('turn/interrupt', { threadId, turnId }).catch(() => {})
      }
    }
    const cancel = (): void => {
      if (finished) return
      if (!startingTurn && !turnId) {
        rejectExecution(new Error('Task cancelled.'))
        return
      }
      interrupt()
      cancelTimer = setTimeout(() => connection?.fail(new Error('Codex did not acknowledge cancellation')), this.options.cancelTimeoutMs ?? 2_000)
    }
    const finish = (turn: CodexTurn): void => {
      if (turn.id !== turnId || finished) return
      if (turn.status === 'inProgress') throw new Error('Codex completed a turn without a terminal status')
      for (const item of turn.items) output.item(item, true)
      finished = true
      resolveTurn(turn)
    }
    const notification = (method: string, params: CodexObject): void => {
      if (finished) return
      if (method === 'warning' || method === 'configWarning') {
        if (params.threadId && params.threadId !== threadId) return
        const message = params.message ?? params.summary
        if (typeof message === 'string') output.line(message, 'system', 'system')
        return
      }
      if (!threadId || params.threadId !== threadId) return
      if (!turnId) {
        if (startingTurn) {
          if (queued.length >= 10_000) throw new Error('Too many Codex events before turn/start response')
          queued.push({ method, params })
        } else if (method === 'thread/tokenUsage/updated') {
          output.updateUsage(params.tokenUsage, false)
        }
        return
      }
      const eventTurnId = method === 'turn/completed' || method === 'turn/started'
        ? codexTurn(params.turn).id
        : params.turnId
      if (eventTurnId !== turnId) return
      if (method === 'turn/completed') finish(codexTurn(params.turn))
      else output.notification(method, params)
    }
    const serverRequest = (method: string, params: CodexObject): unknown => {
      const active = !input.readOnly && !finished && !input.signal?.aborted && params.threadId === threadId &&
        (turnId ? params.turnId === turnId : startingTurn)
      switch (method) {
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval':
          // Full-access tasks need no prompts. Approve only the active request,
          // not a persistent policy amendment or requests from stale turns.
          output.line(`${active ? 'Approved' : 'Cancelled'} Codex approval: ${method}`, 'system', 'system')
          return { decision: active ? 'accept' : 'cancel' }
        case 'item/permissions/requestApproval':
          return { permissions: active ? params.permissions ?? {} : {}, scope: 'turn' }
        case 'mcpServer/elicitation/request':
          return { action: 'cancel', content: null }
        case 'item/tool/requestUserInput':
          output.line('Codex requested user input; Anvil cannot answer questions in a headless task.', 'system', 'system')
          return { answers: {} }
        default:
          throw new CodexRpcError(-32601, `Anvil does not implement Codex server request: ${method}`)
      }
    }

    const execution: CodexExecution = {
      taskId: input.taskId,
      steer: async (steering) => {
        if (finished || input.signal?.aborted || startingTurn || !connection || !threadId || !turnId) {
          throw new Error('Codex is not ready for steering. Wait for an active turn and try again.')
        }
        if (steering.sessionId !== threadId) throw new Error('The task session changed. Try sending again.')
        const response = await request(connection.request('turn/steer', {
          threadId, expectedTurnId: turnId,
          input: [{ type: 'text', text: steering.message, text_elements: [] }]
        }))
        if (response.turnId !== turnId) throw new Error('Codex acknowledged steering for a different turn')
      },
      server: () => connection, thread: () => threadId,
      notification, serverRequest, diagnostic: (text) => output.line(text, 'error', 'stderr')
    }
    this.executions.add(execution)
    try {
      input.signal?.throwIfAborted()
      if (input.workspace.workspaceId !== this.options.workspace.workspaceId || input.workspace.codexHome !== this.options.workspace.codexHome) {
        throw new Error('This Codex client belongs to a different workspace. Use the originating workspace client for this task.')
      }
      if (!isAbsolute(input.cwd)) throw new Error('Codex app-server requires an absolute working directory')
      input.signal?.addEventListener('abort', cancel, { once: true })
      const sandboxPolicy = input.readOnly ? { type: 'readOnly' as const } : codexSandboxPolicy()
      input.signal?.throwIfAborted()
      connection = await request(this.connection((server) => {
        connection = server
        output.line(`$ ${this.options.command ?? 'codex'} ${(this.options.args ?? ['app-server', '--listen', 'stdio://']).join(' ')}`, 'system', 'system')
      }))
      await request(this.requireAuthentication(connection))
      input.signal?.throwIfAborted()
      output.line(`cwd: ${input.cwd}`, 'system', 'system')
      if (input.reasoningEffort !== undefined) {
        const catalogue = await request(this.listModels(input.cwd))
        const capabilities = input.model ? catalogue.reasoningByModel?.[input.model] : undefined
        if (!capabilities?.options.some((option) => option.id === input.reasoningEffort)) {
          throw new Error(`Codex does not advertise reasoning effort ${input.reasoningEffort} for model ${input.model ?? '(unspecified)'}`)
        }
      }
      if (input.images?.length) {
        const cursors = new Set<string>()
        let cursor: string | undefined
        let supportsImages = false
        do {
          const page = await request(connection.request('model/list', { cursor }))
          const selected = page.data.find((model) => input.model ? model.model === input.model : model.isDefault === true)
          if (selected) {
            supportsImages = selected.inputModalities?.includes('image') === true
            break
          }
          cursor = page.nextCursor ?? undefined
          if (cursor !== undefined && cursors.has(cursor)) throw new Error('Codex model/list repeated a pagination cursor')
          if (cursor !== undefined) cursors.add(cursor)
        } while (cursor !== undefined)
        if (!supportsImages) throw new Error(`Codex model ${input.model ?? '(default)'} does not advertise image input. Select an image-capable model or remove the images.`)
      }
      const threadOptions: CodexThreadOptions = {
        cwd: input.cwd, model: input.model, approvalPolicy: 'never' as const, sandbox: input.readOnly ? 'read-only' : 'danger-full-access',
        // Anvil supplies project-scoped memory. Personal Codex memories and
        // plugin suggestions add unrelated context to every model request.
        config: {
          ...(input.reasoningEffort !== undefined ? { model_reasoning_effort: input.reasoningEffort } : {}),
          'memories.use_memories': false,
          'memories.generate_memories': false,
          'features.recommended_plugins': false,
          tool_output_token_limit: 3000,
          // Shell tools must retain Anvil's bundled vl launcher on PATH.
          'shell_environment_policy.set.PATH': this.options.workspace.environment.PATH ?? ''
        }
      }
      let prompt = input.prompt
      const response = await request(input.resumeSessionId
        ? connection.request('thread/resume', { ...threadOptions, threadId: input.resumeSessionId })
        : connection.request('thread/start', threadOptions)).catch(async (failure: unknown) => {
        // Authentication, invalid options, and transport failures must not
        // silently discard conversation history or trigger another execution.
        if (!input.resumeSessionId || !input.resumeFallbackPrompt || input.readOnly ||
          !(failure instanceof CodexRpcError) ||
          failure.message !== `no rollout found for thread id ${input.resumeSessionId}`) throw failure
        input.signal?.throwIfAborted()
        output.line(`Saved Codex session ${input.resumeSessionId} is unavailable in the current Codex home. Starting a new session from the saved task plan and branch; previous conversation history was not restored.`, 'system', 'system')
        prompt = input.resumeFallbackPrompt
        // The new thread has no historic usage to subtract.
        output = new CodexAppServerOutput({ ...input, resumeSessionId: undefined }, onEvent)
        return request(connection!.request('thread/start', threadOptions))
      })
      // Anvil's sessionId is the resume handle. Codex resumes by thread.id, not
      // thread.sessionId, which can be shared by multiple forked threads.
      threadId = response.thread.id
      onEvent({ type: 'session', taskId: input.taskId, sessionId: threadId })
      input.signal?.throwIfAborted()
      input.beforeDispatch?.()
      startingTurn = true
      const started = await connection.request('turn/start', {
        threadId, cwd: input.cwd, sandboxPolicy,
        input: [
          { type: 'text', text: prompt, text_elements: [] },
          ...(input.images ?? []).map((image) => ({ type: 'image' as const, url: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString('base64')}` }))
        ]
      })
      turnId = started.turn.id
      input.onStarted?.()
      startingTurn = false
      for (const event of queued) notification(event.method, event.params)
      queued.length = 0
      if (started.turn.status !== 'inProgress') finish(started.turn)
      if (input.signal?.aborted) interrupt()
      const turn = await Promise.race([completed, connection.failure])
      stopReason = turn.status
      status = input.signal?.aborted || turn.status === 'interrupted' ? 'cancelled' : turn.status === 'completed' ? 'succeeded' : 'failed'
      if (status === 'failed') {
        error = turn.error?.message ?? 'Codex turn failed'
        retry = retryableAgentFailure(turn.error)
      }
    } catch (failure) {
      status = input.signal?.aborted ? 'cancelled' : 'failed'
      if (status === 'failed') {
        error = failure instanceof Error ? failure.message : String(failure)
        if (connection?.failureReason) {
          try {
            const reason = connection.failureReason
            await connection.close()
            retry = retryableAgentFailure(reason)
          } catch {
            error += ' Could not stop the failed agent server.'
          }
        } else if (startingTurn && failure instanceof CodexRpcError) {
          retry = retryableAgentFailure(failure)
        }
      }
    } finally {
      finished = true
      input.signal?.removeEventListener('abort', cancel)
      clearTimeout(cancelTimer)
      connection?.flushDiagnostic()
      await connection?.drainDiagnostic()
      this.executions.delete(execution)
      output.flush()
    }
    if (error) output.line(error, 'error', 'system')
    output.line(status === 'cancelled' ? 'Task cancelled.' : `Codex turn ${status}.`, 'system', 'system')
    return {
      taskId: input.taskId, issueId: input.issueId, status, sessionId: threadId,
      stopReason, error, retry, output: output.output, changedFiles: [...output.changedFiles], usage: output.usage
    }
  }
}
