import { isAbsolute } from 'node:path'
import type { AgentExecutor, TaskEvent, TaskInput, TaskResult } from './agent-executor'
import { CodexAppServerConnection, CodexRpcError, type CodexAppServerOptions } from './codex-app-server-connection'
import { CodexAppServerOutput } from './codex-app-server-output'
import { codexTurn, type CodexObject, type CodexTurn } from './codex-app-server-protocol'

/** Codex's app-server protocol adapted to Anvil tasks. No ACP messages are used. */
export class CodexAppServerClient implements AgentExecutor {
  constructor(private readonly options: CodexAppServerOptions = {}) {}

  async execute(input: TaskInput, onEvent: (event: TaskEvent) => void): Promise<TaskResult> {
    const output = new CodexAppServerOutput(input, onEvent)
    let connection: CodexAppServerConnection | undefined
    let threadId = input.resumeSessionId
    let turnId: string | undefined
    let startingTurn = false
    let finished = false
    let status: TaskResult['status'] = 'failed'
    let stopReason: string | undefined
    let error: string | undefined
    let cancelTimer: ReturnType<typeof setTimeout> | undefined
    const queued: Array<{ method: string; params: CodexObject }> = []
    let resolveTurn!: (turn: CodexTurn) => void
    const completed = new Promise<CodexTurn>((resolve) => { resolveTurn = resolve })

    const interrupt = (): void => {
      if (connection && threadId && turnId && !finished) {
        void connection.request('turn/interrupt', { threadId, turnId }).catch(() => {})
      }
    }
    const cancel = (): void => {
      if (finished || !connection) return
      if (!startingTurn && !turnId) {
        connection.fail(new Error('Task cancelled.'))
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
      const active = !finished && !input.signal?.aborted && params.threadId === threadId &&
        (turnId ? params.turnId === turnId : startingTurn)
      switch (method) {
        case 'item/commandExecution/requestApproval':
        case 'item/fileChange/requestApproval':
          // Never turn a headless task into approval of a sandbox escape or a
          // persistent policy amendment. The configured policy is `never`.
          output.line(`Declined Codex approval: ${method}`, 'system', 'system')
          return { decision: active ? 'decline' : 'cancel' }
        case 'item/permissions/requestApproval':
          return { permissions: {}, scope: 'turn' }
        case 'mcpServer/elicitation/request':
          return { action: 'cancel', content: null }
        case 'item/tool/requestUserInput':
          output.line('Codex requested user input; Anvil cannot answer questions in a headless task.', 'system', 'system')
          return { answers: {} }
        default:
          throw new CodexRpcError(-32601, `Anvil does not implement Codex server request: ${method}`)
      }
    }

    try {
      input.signal?.throwIfAborted()
      if (!isAbsolute(input.cwd)) throw new Error('Codex app-server requires an absolute working directory')
      output.line(`$ ${this.options.command ?? 'codex'} ${(this.options.args ?? ['app-server', '--listen', 'stdio://']).join(' ')}`, 'system', 'system')
      output.line(`cwd: ${input.cwd}`, 'system', 'system')
      connection = new CodexAppServerConnection(input.cwd, this.options, {
        notification, serverRequest, diagnostic: (text) => output.line(text, 'error', 'stderr')
      })
      input.signal?.addEventListener('abort', cancel, { once: true })
      if (input.signal?.aborted) cancel()
      await connection.request('initialize', { clientInfo: { name: 'anvil', title: 'Anvil', version: '0.1.0' } })
      connection.initialized()
      const options = { cwd: input.cwd, model: input.model, approvalPolicy: 'never' as const, sandbox: 'workspaceWrite' as const }
      const response = input.resumeSessionId
        ? await connection.request('thread/resume', { ...options, threadId: input.resumeSessionId })
        : await connection.request('thread/start', options)
      // Anvil's sessionId is the resume handle. Codex resumes by thread.id, not
      // thread.sessionId, which can be shared by multiple forked threads.
      threadId = response.thread.id
      onEvent({ type: 'session', taskId: input.taskId, sessionId: threadId })
      input.signal?.throwIfAborted()
      startingTurn = true
      const started = await connection.request('turn/start', {
        threadId, input: [{ type: 'text', text: input.prompt, text_elements: [] }]
      })
      turnId = started.turn.id
      startingTurn = false
      for (const event of queued) notification(event.method, event.params)
      queued.length = 0
      if (started.turn.status !== 'inProgress') finish(started.turn)
      if (input.signal?.aborted) interrupt()
      const turn = await Promise.race([completed, connection.failure])
      stopReason = turn.status
      status = input.signal?.aborted || turn.status === 'interrupted' ? 'cancelled' : turn.status === 'completed' ? 'succeeded' : 'failed'
      if (status === 'failed') error = turn.error?.message ?? 'Codex turn failed'
    } catch (failure) {
      status = input.signal?.aborted ? 'cancelled' : 'failed'
      if (status === 'failed') error = failure instanceof Error ? failure.message : String(failure)
    } finally {
      finished = true
      input.signal?.removeEventListener('abort', cancel)
      clearTimeout(cancelTimer)
      await connection?.close()
      output.flush()
    }
    if (error) output.line(error, 'error', 'system')
    output.line(status === 'cancelled' ? 'Task cancelled.' : `Codex turn ${status}.`, 'system', 'system')
    return {
      taskId: input.taskId, issueId: input.issueId, status, sessionId: threadId,
      stopReason, error, output: output.output, changedFiles: [...output.changedFiles], usage: output.usage
    }
  }
}
