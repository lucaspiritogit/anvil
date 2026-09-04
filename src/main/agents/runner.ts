import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { resolveCommand } from './resolve'
import { parseAgentLine } from './output'
import type { AgentDefinition, RunEvent, RunUsage, StreamName } from '../../shared/types'

const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g

export interface StartOptions {
  runId: string
  agent: AgentDefinition
  prompt: string
  model?: string
  cwd: string
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

export function buildArgs(template: string[], prompt: string, model?: string): string[] {
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
    out.push(token.replaceAll('{{prompt}}', prompt))
  }
  return out
}

export class AgentRunner extends EventEmitter {
  private procs = new Map<string, ChildProcess>()
  private cancelled = new Set<string>()
  private usage = new Map<string, RunUsage>()

  isRunning(runId: string): boolean {
    return this.procs.has(runId)
  }

  private emitLine(runId: string, stream: StreamName, text: string): void {
    const event: RunEvent = {
      id: randomUUID(),
      runId,
      ts: Date.now(),
      stream,
      kind: 'output',
      text: text.replace(ANSI, '').replace(/\r$/, '')
    }
    this.emit('event', event)
  }

  private updateUsage(runId: string, patch: Partial<RunUsage>, mode: 'add' | 'set'): void {
    const current = this.usage.get(runId) ?? {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      costUsd: null
    }
    const numberValue = (key: keyof Omit<RunUsage, 'costUsd'>): number => {
      const value = patch[key]
      if (typeof value !== 'number') return current[key]
      return mode === 'add' ? current[key] + value : value
    }
    const costUsd =
      patch.costUsd === undefined
        ? current.costUsd
        : patch.costUsd === null
          ? current.costUsd
          : mode === 'add'
            ? (current.costUsd ?? 0) + patch.costUsd
            : patch.costUsd
    const next: RunUsage = {
      inputTokens: numberValue('inputTokens'),
      outputTokens: numberValue('outputTokens'),
      cachedTokens: numberValue('cachedTokens'),
      totalTokens: numberValue('totalTokens'),
      costUsd
    }
    this.usage.set(runId, next)
    this.emit('usage', { runId, ...next } satisfies UsageInfo)
  }

  private handleLine(
    runId: string,
    agent: AgentDefinition,
    stream: StreamName,
    line: string
  ): void {
    if (stream !== 'stdout' || !agent.outputProtocol) {
      this.emitLine(runId, stream, line)
      return
    }
    const parsed = parseAgentLine(agent.outputProtocol, line)
    if (parsed.usage && parsed.usageMode) {
      this.updateUsage(runId, parsed.usage, parsed.usageMode)
    }
    if (!parsed.text) return
    for (const text of parsed.text.split(/\r?\n/)) {
      this.emitLine(runId, parsed.stream ?? stream, text)
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
    const { runId, agent, prompt, model, cwd } = opts
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
      this.emitLine(runId, 'system', `Command not found on PATH: "${agent.command}"`)
      this.emit('exit', {
        runId,
        code: null,
        cancelled: false,
        error: `"${agent.command}" is not installed or not on PATH`
      } satisfies ExitInfo)
      return
    }

    const agentArgs = buildArgs(agent.args, prompt, model)
    const args = [...resolved.prefixArgs, ...agentArgs]

    this.emitLine(runId, 'system', `$ ${agent.command} ${agentArgs.join(' ')}`)
    this.emitLine(runId, 'system', `cwd: ${cwd}`)

    let child: ChildProcess
    try {
      child = spawn(resolved.command, args, {
        cwd,
        shell: resolved.viaShell,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' }
      })
    } catch (err) {
      this.usage.delete(runId)
      const message = err instanceof Error ? err.message : String(err)
      this.emitLine(runId, 'system', `Failed to spawn: ${message}`)
      this.emit('exit', { runId, code: null, cancelled: false, error: message } satisfies ExitInfo)
      return
    }

    this.procs.set(runId, child)

    const flushOut = this.pipe(runId, agent, 'stdout', child.stdout!)
    const flushErr = this.pipe(runId, agent, 'stderr', child.stderr!)

    child.on('error', (err) => {
      this.emitLine(runId, 'system', `Process error: ${err.message}`)
    })

    child.on('close', (code) => {
      flushOut()
      flushErr()
      this.procs.delete(runId)
      this.usage.delete(runId)
      const cancelled = this.cancelled.delete(runId)
      this.emitLine(
        runId,
        'system',
        cancelled ? 'Run cancelled.' : `Process exited with code ${code}.`
      )
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
