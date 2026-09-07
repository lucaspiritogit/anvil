import { isAbsolute } from 'node:path'
import type { Client } from '@agentclientprotocol/sdk'
import type { AgentClientProtocol, TaskEvent, TaskInput, TaskResult } from './agent-client-protocol'
import { AcpOutput } from './acp-output'
import { OpenCodeAcpConnection, type OpenCodeAcpOptions } from './opencode-acp-connection'
import { LazyAgentServer } from './lazy-agent-server'

interface AcpExecution {
  server(): OpenCodeAcpConnection | undefined
  session(): string | undefined
  client: Client
  diagnostic(text: string): void
}

/** One lazy ACP server, with separate sessions and output routing for each turn. */
export class OpenCodeAcpClient implements AgentClientProtocol {
  private readonly server = new LazyAgentServer<OpenCodeAcpConnection>()
  private readonly executions = new Set<AcpExecution>()

  constructor(private readonly options: OpenCodeAcpOptions = {}) {}

  close(): Promise<void> {
    return this.server.close()
  }

  async execute(input: TaskInput, onEvent: (event: TaskEvent) => void): Promise<TaskResult> {
    const output = new AcpOutput(input, onEvent)
    let sessionId: string | undefined
    let status: TaskResult['status'] = 'failed'
    let stopReason: string | undefined
    let error: string | undefined
    let connection: OpenCodeAcpConnection | undefined
    let startupTimer: ReturnType<typeof setTimeout> | undefined
    let cancelTimer: ReturnType<typeof setTimeout> | undefined
    let acceptingUpdates = false
    let rejectExecution: (error: Error) => void = () => {}
    const interrupted = new Promise<never>((_, reject) => { rejectExecution = reject })
    void interrupted.catch(() => {})
    const cancel = (): void => {
      if (connection && sessionId && acceptingUpdates) {
        void connection.rpc.cancel({ sessionId }).catch(() => {})
        // An unresponsive turn may still be executing tools. Retire the server
        // rather than report cancellation while leaving those tools running.
        cancelTimer = setTimeout(() => connection?.fail(new Error('OpenCode did not acknowledge cancellation')), this.options.cancelTimeoutMs ?? 2_000)
      } else {
        rejectExecution(new Error('Task cancelled.'))
      }
    }
    const execution: AcpExecution = {
      server: () => connection,
      session: () => sessionId,
      diagnostic: (text) => output.line(text, 'error', 'stderr'),
      client: {
        sessionUpdate: async (notification) => {
          if (acceptingUpdates && notification.sessionId === sessionId) output.update(notification.update)
        },
        requestPermission: async (request) => {
          if (input.signal?.aborted || !acceptingUpdates || request.sessionId !== sessionId) {
            return { outcome: { outcome: 'cancelled' } }
          }
          const option = request.options.find((option) => option.kind === 'allow_once')
          output.line(`${option ? 'Allowed' : 'Cancelled'} tool permission: ${request.toolCall.title ?? request.toolCall.toolCallId}`, 'system', 'system')
          return option
            ? { outcome: { outcome: 'selected', optionId: option.optionId } }
            : { outcome: { outcome: 'cancelled' } }
        }
      }
    }
    this.executions.add(execution)
    try {
      input.signal?.throwIfAborted()
      if (!isAbsolute(input.cwd)) throw new Error('ACP requires an absolute working directory')
      input.signal?.addEventListener('abort', cancel, { once: true })
      const ready = this.server.get(() => {
        const command = this.options.command ?? 'opencode'
        output.line(`$ ${command} ${(this.options.args ?? ['acp']).join(' ')}`, 'system', 'system')
        const server: OpenCodeAcpConnection = new OpenCodeAcpConnection(input.cwd, this.options, {
          sessionUpdate: async (notification) => {
            for (const active of this.executions) {
              if (active.server() === server && active.session() === notification.sessionId) {
                await active.client.sessionUpdate(notification)
              }
            }
          },
          requestPermission: async (request) => {
            const active = [...this.executions].find((entry) => entry.server() === server && entry.session() === request.sessionId)
            return active ? active.client.requestPermission(request) : { outcome: { outcome: 'cancelled' } }
          }
        }, (text) => {
          for (const active of this.executions) if (active.server() === server) active.diagnostic(text)
        })
        connection = server
        return server
      }, (server) => server.initialize())
      connection = await Promise.race([ready, interrupted])
      input.signal?.throwIfAborted()
      const request = <Response>(promise: Promise<Response>): Promise<Response> => Promise.race([promise, connection!.failure, interrupted])
      output.line(`cwd: ${input.cwd}`, 'system', 'system')
      startupTimer = setTimeout(() => connection?.fail(new Error('OpenCode ACP session startup timed out.')), this.options.startupTimeoutMs ?? 60_000)
      if (input.resumeSessionId) {
        if (!connection.supportsLoadSession) throw new Error('OpenCode does not support loading sessions')
        sessionId = input.resumeSessionId
        // Loading replays history. Do not count it as this turn's evidence.
        await request(connection.rpc.loadSession({ sessionId, cwd: input.cwd, mcpServers: [] }))
      } else {
        const session = await request(connection.rpc.newSession({ cwd: input.cwd, mcpServers: [] }))
        sessionId = session.sessionId
      }
      input.signal?.throwIfAborted()
      onEvent({ type: 'session', taskId: input.taskId, sessionId })
      if (input.model) {
        await request(connection.rpc.setSessionConfigOption({ sessionId, configId: 'model', value: input.model }))
      }
      clearTimeout(startupTimer)
      input.signal?.throwIfAborted()
      acceptingUpdates = true
      const response = await request(connection.rpc.prompt({ sessionId, prompt: [{ type: 'text', text: input.prompt }] }))
      output.finishUsage(response.usage)
      stopReason = response.stopReason
      status = input.signal?.aborted || stopReason === 'cancelled' ? 'cancelled' : stopReason === 'end_turn' ? 'succeeded' : 'failed'
      if (status === 'failed') error = `OpenCode stopped with reason: ${stopReason}`
    } catch (failure) {
      status = input.signal?.aborted ? 'cancelled' : 'failed'
      if (status === 'failed') error = failure instanceof Error ? failure.message : String(failure)
    } finally {
      acceptingUpdates = false
      clearTimeout(startupTimer)
      clearTimeout(cancelTimer)
      input.signal?.removeEventListener('abort', cancel)
      connection?.flushDiagnostic()
      this.executions.delete(execution)
      output.flush()
    }
    if (error) output.line(error, 'error', 'system')
    output.line(status === 'cancelled' ? 'Task cancelled.' : `ACP turn ${status}.`, 'system', 'system')
    return {
      taskId: input.taskId, issueId: input.issueId, status, sessionId, stopReason, error,
      output: output.output, changedFiles: [...output.changedFiles], usage: output.usage
    }
  }
}
