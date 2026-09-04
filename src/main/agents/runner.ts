import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { resolveCommand } from './resolve'
import { parseAgentLine } from './output'
import type {
  AgentDefinition,
  RunEvent,
  RunEventCategory,
  RunUsage,
  StreamName
} from '../../shared/types'

const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g

export interface StartOptions {
  runId: string
  agent: AgentDefinition
  prompt: string
  model?: string
  cwd: string
  /** Resume this agent session instead of starting a fresh one. */
  resumeSessionId?: string
}

export interface ExitInfo {
  runId: string
  code: number | null
  cancelled: boolean
  error?: string
}

export interface UsageInfo extends RunUsage {
  runId: string
}

export interface SessionInfo {
  runId: string
  sessionId: string
}

const EMPTY_USAGE: RunUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  totalTokens: 0,
  costUsd: null
}

function mergeUsage(current: RunUsage, patch: Partial<RunUsage>, mode: 'add' | 'set'): RunUsage {
  const numberValue = (key: keyof Omit<RunUsage, 'costUsd'>): number => {
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
  session?: string
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
    out.push(token.replaceAll('{{prompt}}', prompt))
  }
  return out
}

export class AgentRunner extends EventEmitter {
  private procs = new Map<string, ChildProcess>()
  private cancelled = new Set<string>()
  private usage = new Map<string, RunUsage>()
  private sessions = new Map<string, string>()

  isRunning(runId: string): boolean {
    return this.procs.has(runId)
  }

  private emitLine(
    runId: string,
    stream: StreamName,
    text: string,
    category: RunEventCategory
  ): void {
    const event: RunEvent = {
      id: randomUUID(),
      runId,
      ts: Date.now(),
      stream,
      kind: 'output',
      category,
      text: text.replace(ANSI, '').replace(/\r$/, '')
    }
    this.emit('event', event)
  }

  /** Anvil's own commentary about the process, not the agent's output. */
  private emitSystem(runId: string, text: string, failed = false): void {
    this.emitLine(runId, 'system', text, failed ? 'error' : 'system')
  }

  private updateUsage(runId: string, patch: Partial<RunUsage>, mode: 'add' | 'set'): void {
    const next = mergeUsage(this.usage.get(runId) ?? EMPTY_USAGE, patch, mode)
    this.usage.set(runId, next)
    this.emit('usage', { runId, ...next } satisfies UsageInfo)
  }

  private handleLine(
    runId: string,
    agent: AgentDefinition,
    stream: StreamName,
    line: string
  ): void {
    // Everything on stderr is an error, whatever the agent's protocol is.
    if (stream === 'stderr') {
      this.emitLine(runId, 'stderr', line, 'error')
      return
    }
    if (!agent.outputProtocol) {
      this.emitLine(runId, stream, line, 'message')
      return
    }
    const parsed = parseAgentLine(agent.outputProtocol, line)
    if (parsed.sessionId && this.sessions.get(runId) !== parsed.sessionId) {
      this.sessions.set(runId, parsed.sessionId)
      this.emit('session', { runId, sessionId: parsed.sessionId } satisfies SessionInfo)
    }
    if (parsed.usage && parsed.usageMode) {
      this.updateUsage(runId, parsed.usage, parsed.usageMode)
    }
    for (const part of parsed.parts) {
      for (const text of part.text.split(/\r?\n/)) {
        this.emitLine(runId, part.stream, text, part.category)
      }
    }
  }

  private pipe(
    runId: string,
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
      for (const line of lines) this.handleLine(runId, agent, stream, line)
    })
    return () => {
      if (buffer.trim()) this.handleLine(runId, agent, stream, buffer)
      buffer = ''
    }
  }

  start(opts: StartOptions): void {
    const { runId, agent, prompt, model, cwd, resumeSessionId } = opts
    this.usage.set(runId, {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      costUsd: null
    })

    const resolved = resolveCommand(agent.command)
    if (!resolved) {
      this.usage.delete(runId)
      this.emitSystem(runId, `Command not found on PATH: "${agent.command}"`, true)
      this.emit('exit', {
        runId,
        code: null,
        cancelled: false,
        error: `"${agent.command}" is not installed or not on PATH`
      } satisfies ExitInfo)
      return
    }

    const resuming = Boolean(resumeSessionId && agent.resumeArgs)
    const template = resuming ? agent.resumeArgs! : agent.args
    const agentArgs = buildArgs(template, prompt, model, resumeSessionId)
    const args = [...resolved.prefixArgs, ...agentArgs]

    this.emitSystem(runId, `$ ${agent.command} ${agentArgs.join(' ')}`)
    this.emitSystem(runId, `cwd: ${cwd}`)

    let child: ChildProcess
    try {
      child = spawn(resolved.command, args, {
        cwd,
        shell: resolved.viaShell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // spawn() chdirs the child but leaves PWD pointing at Anvil's own launch
        // directory. An agent that trusts $PWD over getcwd() would write its
        // files there instead of into the worktree.
        env: { ...process.env, PWD: cwd, NO_COLOR: '1', FORCE_COLOR: '0' }
      })
    } catch (err) {
      this.usage.delete(runId)
      const message = err instanceof Error ? err.message : String(err)
      this.emitSystem(runId, `Failed to spawn: ${message}`, true)
      this.emit('exit', { runId, code: null, cancelled: false, error: message } satisfies ExitInfo)
      return
    }

    this.procs.set(runId, child)

    const flushOut = this.pipe(runId, agent, 'stdout', child.stdout!)
    const flushErr = this.pipe(runId, agent, 'stderr', child.stderr!)

    child.on('error', (err) => {
      this.emitSystem(runId, `Process error: ${err.message}`, true)
    })

    child.on('close', (code) => {
      flushOut()
      flushErr()
      this.procs.delete(runId)
      this.usage.delete(runId)
      this.sessions.delete(runId)
      const cancelled = this.cancelled.delete(runId)
      this.emitSystem(runId, cancelled ? 'Run cancelled.' : `Process exited with code ${code}.`)
      this.emit('exit', { runId, code, cancelled } satisfies ExitInfo)
    })
  }

  cancel(runId: string): boolean {
    const child = this.procs.get(runId)
    if (!child?.pid) return false
    this.cancelled.add(runId)

    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      child.kill('SIGTERM')
    }
    return true
  }

  cancelAll(): void {
    for (const runId of [...this.procs.keys()]) this.cancel(runId)
  }
}
