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
  TaskEvent,
  TaskEventCategory,
  TaskUsage,
  StreamName
} from '../../shared/types'

const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g

export interface StartOptions {
  taskId: string
  issueId?: string
  agent: AgentDefinition
  prompt: string
  model?: string
  reasoningEffort?: string
  cwd: string
  projectPath?: string
  /** Resume this agent session instead of starting a fresh one. */
  resumeSessionId?: string
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

  constructor(
    private readonly openCodeClient: AgentExecutor = getAgentAdapter('opencode').createExecutor(),
    private readonly codexClient: AgentExecutor = getAgentAdapter('codex').createExecutor()
  ) {
    super()
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

  private startServer(opts: StartOptions, client: AgentExecutor): void {
    const controller = new AbortController()
    this.serverExecutions.set(opts.taskId, controller)
    if (opts.agent.supportsSteering && client.steer) this.steeringExecutors.set(opts.taskId, client)
    const { agent: _agent, ...input } = opts
    const completion = client.execute({ ...input, signal: controller.signal }, (event) => {
      switch (event.type) {
        case 'output':
          this.emit('event', event.event)
          break
        case 'session':
          this.emit('session', { taskId: event.taskId, sessionId: event.sessionId } satisfies SessionInfo)
          break
        case 'usage':
          this.emit('usage', { taskId: event.taskId, ...event.usage } satisfies UsageInfo)
          break
      }
    }).then((result) => {
      this.steeringExecutors.delete(opts.taskId)
      this.serverExecutions.delete(opts.taskId)
      this.emit('exit', {
        taskId: opts.taskId,
        code: result.status === 'succeeded' ? 0 : result.status === 'cancelled' ? null : 1,
        cancelled: result.status === 'cancelled', error: result.error, result
      } satisfies ExitInfo)
    }, (failure: unknown) => {
      this.steeringExecutors.delete(opts.taskId)
      this.serverExecutions.delete(opts.taskId)
      const error = failure instanceof Error ? failure.message : String(failure)
      this.emitSystem(opts.taskId, error, true)
      this.emit('exit', { taskId: opts.taskId, code: null, cancelled: controller.signal.aborted, error } satisfies ExitInfo)
    })
    this.completions.add(completion)
    void completion.finally(() => this.completions.delete(completion))
  }

  private emitLine(
    taskId: string,
    stream: StreamName,
    text: string,
    category: TaskEventCategory
  ): void {
    const event: TaskEvent = {
      id: randomUUID(),
      taskId,
      ts: Date.now(),
      stream,
      kind: 'output',
      category,
      text: text.replace(ANSI, '').replace(/\r$/, '')
    }
    this.emit('event', event)
  }

  /** Anvil's own commentary about the process, not the agent's output. */
  private emitSystem(taskId: string, text: string, failed = false): void {
    this.emitLine(taskId, 'system', text, failed ? 'error' : 'system')
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
    line: string
  ): void {
    // Everything on stderr is an error, whatever the agent's protocol is.
    if (stream === 'stderr') {
      this.emitLine(taskId, 'stderr', line, 'error')
      return
    }
    if (!agent.outputProtocol) {
      this.emitLine(taskId, stream, line, 'message')
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
        this.emitLine(taskId, part.stream, text, part.category)
      }
    }
  }

  private pipe(
    taskId: string,
    agent: AgentDefinition,
    stream: StreamName,
    src: NodeJS.ReadableStream
  ): () => void {
    let buffer = ''
    src.setEncoding('utf8')
    src.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) this.handleLine(taskId, agent, stream, line)
    })
    return () => {
      if (buffer.trim()) this.handleLine(taskId, agent, stream, buffer)
      buffer = ''
    }
  }

  start(opts: StartOptions): void {
    if (this.shutdown) throw new Error('Agent processes are shutting down')
    if (this.isRunning(opts.taskId)) throw new Error('This task is already running')
    if (opts.agent.executionProtocol === 'acp') {
      this.startServer(opts, this.openCodeClient)
      return
    }
    if (opts.agent.executionProtocol === 'codex-app-server') {
      this.startServer(opts, this.codexClient)
      return
    }
    const { taskId, agent, prompt, model, reasoningEffort, cwd, resumeSessionId } = opts
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
      this.emitSystem(taskId, `Command not found on PATH: "${agent.command}"`, true)
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

    this.emitSystem(taskId, `$ ${agent.command} ${agentArgs.join(' ')}`)
    this.emitSystem(taskId, `cwd: ${cwd}`)

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
        // files there instead of into the worktree.
        env: { ...process.env, PWD: cwd, NO_COLOR: '1', FORCE_COLOR: '0' }
      })
    } catch (err) {
      this.usage.delete(taskId)
      const message = err instanceof Error ? err.message : String(err)
      this.emitSystem(taskId, `Failed to spawn: ${message}`, true)
      this.emit('exit', { taskId, code: null, cancelled: false, error: message } satisfies ExitInfo)
      return
    }

    this.procs.set(taskId, child)

    const flushOut = this.pipe(taskId, agent, 'stdout', child.stdout!)
    const flushErr = this.pipe(taskId, agent, 'stderr', child.stderr!)

    child.on('error', (err) => {
      this.emitSystem(taskId, `Process error: ${err.message}`, true)
    })

    child.on('close', (code) => {
      flushOut()
      flushErr()
      this.procs.delete(taskId)
      this.usage.delete(taskId)
      this.sessions.delete(taskId)
      const cancelled = this.cancelled.delete(taskId)
      this.emitSystem(taskId, cancelled ? 'Task cancelled.' : `Process exited with code ${code}.`)
      this.emit('exit', { taskId, code, cancelled } satisfies ExitInfo)
    })
  }

  cancel(taskId: string): boolean {
    const execution = this.serverExecutions.get(taskId)
    if (execution) {
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
      const processes = [...this.procs.entries()].map(([taskId, child]) => {
        this.cancelled.add(taskId)
        const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
        return closeAgentServer(child, closed)
      })
      this.cancelAll()
      await Promise.all([
        ...processes, ...this.completions,
        this.openCodeClient.close?.(), this.codexClient.close?.()
      ])
    })
    return this.shutdown
  }
}
