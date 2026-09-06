import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { isAbsolute } from 'node:path'
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { AgentClientProtocol, TaskEvent, TaskInput, TaskResult } from './agent-client-protocol'
import { AcpOutput } from './acp-output'
import { resolveCommand } from './resolve'
import { killAgentServer } from './agent-server-process'

interface OpenCodeAcpOptions {
  command?: string
  args?: string[]
  startupTimeoutMs?: number
  cancelTimeoutMs?: number
}

/** One ACP server subprocess per execution. OpenCode persists sessions for later turns. */
export class OpenCodeAcpClient implements AgentClientProtocol {
  constructor(private readonly options: OpenCodeAcpOptions = {}) {}

  async execute(input: TaskInput, onEvent: (event: TaskEvent) => void): Promise<TaskResult> {
    const output = new AcpOutput(input, onEvent)
    let sessionId: string | undefined
    let status: TaskResult['status'] = 'failed'
    let stopReason: string | undefined
    let error: string | undefined
    let child: ChildProcess | undefined
    let connection: ClientSideConnection | undefined
    let closed: Promise<void> | undefined
    let startupTimer: ReturnType<typeof setTimeout> | undefined
    let cancelTimer: ReturnType<typeof setTimeout> | undefined
    let acceptingUpdates = false
    let rejectExecution: (error: Error) => void = () => {}
    const interrupted = new Promise<never>((_, reject) => { rejectExecution = reject })
    // An abort or spawn error can happen before the first request is made.
    void interrupted.catch(() => {})
    const cancelledError = (): Error => new Error('Task cancelled.')
    const cancel = (): void => {
      if (connection && sessionId && acceptingUpdates) {
        void connection.cancel({ sessionId }).catch(() => {})
        cancelTimer = setTimeout(() => rejectExecution(cancelledError()), this.options.cancelTimeoutMs ?? 2_000)
      } else {
        rejectExecution(cancelledError())
      }
    }

    try {
      input.signal?.throwIfAborted()
      if (!isAbsolute(input.cwd)) throw new Error('ACP requires an absolute working directory')
      const command = this.options.command ?? 'opencode'
      const resolved = resolveCommand(command)
      if (!resolved) throw new Error(`"${command}" is not installed or not on PATH`)
      const args = this.options.args ?? ['acp']
      output.line(`$ ${command} ${args.join(' ')}`, 'system', 'system')
      output.line(`cwd: ${input.cwd}`, 'system', 'system')
      child = spawn(resolved.command, [...resolved.prefixArgs, ...args], {
        cwd: input.cwd,
        shell: resolved.viaShell,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PWD: input.cwd, NO_COLOR: '1', FORCE_COLOR: '0' }
      })
      closed = new Promise<void>((resolve) => { child!.once('close', () => resolve()) })
      // A tool can inherit the pipes and delay `close` after the server exits.
      // Stop its process group instead of waiting indefinitely for those pipes.
      child.once('exit', (code, signal) => {
        rejectExecution(new Error(`OpenCode ACP server exited before completing the turn (${signal ?? code}).`))
      })
      child.on('error', (error) => rejectExecution(error))
      let stderr = ''
      child.stderr!.setEncoding('utf8')
      child.stderr!.on('data', (chunk: string) => {
        const lines = (stderr + chunk).split('\n')
        stderr = lines.pop() ?? ''
        for (const line of lines) output.line(line, 'error', 'stderr')
      })
      child.stderr!.on('end', () => { if (stderr) output.line(stderr, 'error', 'stderr') })
      connection = new ClientSideConnection(() => ({
        sessionUpdate: async (notification) => {
          if (acceptingUpdates && notification.sessionId === sessionId) output.update(notification.update)
        },
        requestPermission: async (request) => {
          if (input.signal?.aborted || !acceptingUpdates || request.sessionId !== sessionId) {
            return { outcome: { outcome: 'cancelled' } }
          }
          // Preserve Anvil's non-interactive auto-approval policy, without granting
          // persistent permissions. Never choose a deny option as an approval.
          const option = request.options.find((option) => option.kind === 'allow_once')
          output.line(`${option ? 'Allowed' : 'Cancelled'} tool permission: ${request.toolCall.title ?? request.toolCall.toolCallId}`, 'system', 'system')
          return option
            ? { outcome: { outcome: 'selected', optionId: option.optionId } }
            : { outcome: { outcome: 'cancelled' } }
        }
      }), ndJsonStream(
        Writable.toWeb(child.stdin!),
        Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
      ))
      input.signal?.addEventListener('abort', cancel, { once: true })
      if (input.signal?.aborted) cancel()
      startupTimer = setTimeout(() => rejectExecution(new Error('OpenCode ACP startup timed out.')), this.options.startupTimeoutMs ?? 60_000)
      const request = <Response>(promise: Promise<Response>): Promise<Response> => Promise.race([promise, interrupted])
      const initialized = await request(connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'anvil', version: '0.1.0' },
        // OpenCode executes tools itself. Do not advertise filesystem or terminal
        // operations that Anvil does not implement.
        clientCapabilities: {}
      }))
      if (initialized.protocolVersion !== PROTOCOL_VERSION) throw new Error(`Unsupported ACP version: ${initialized.protocolVersion}`)
      if (input.resumeSessionId) {
        if (!initialized.agentCapabilities?.loadSession) throw new Error('OpenCode does not support loading sessions')
        sessionId = input.resumeSessionId
        // session/load replays old output. Keep it out of events and issue evidence.
        await request(connection.loadSession({ sessionId, cwd: input.cwd, mcpServers: [] }))
      } else {
        const session = await request(connection.newSession({ cwd: input.cwd, mcpServers: [] }))
        sessionId = session.sessionId
      }
      input.signal?.throwIfAborted()
      onEvent({ type: 'session', taskId: input.taskId, sessionId })
      if (input.model) {
        await request(connection.setSessionConfigOption({ sessionId, configId: 'model', value: input.model }))
      }
      clearTimeout(startupTimer)
      input.signal?.throwIfAborted()
      acceptingUpdates = true
      const response = await request(connection.prompt({ sessionId, prompt: [{ type: 'text', text: input.prompt }] }))
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
      if (child && closed) {
        killAgentServer(child)
        const forceKill = setTimeout(() => killAgentServer(child!, true), 1_000)
        await closed
        clearTimeout(forceKill)
      }
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
