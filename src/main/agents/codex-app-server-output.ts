import { randomUUID } from 'node:crypto'
import type { TaskEventCategory, TaskUsage } from '../../shared/types'
import type { TaskEvent, TaskInput } from './agent-executor'
import { codexId, codexObject, codexString, type CodexObject } from './codex-app-server-protocol'
import { ToolOutput, toolInputDescription } from './tool-output'
import { StreamingTextOutput } from './streaming-text-output'

const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g
const ZERO_USAGE: TaskUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null }

function tokenUsage(value: unknown): TaskUsage {
  const usage = codexObject(value)
  const count = (key: string): number => {
    const value = usage[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid Codex token count: ${key}`)
    return value
  }
  return {
    inputTokens: count('inputTokens'), outputTokens: count('outputTokens'),
    cachedTokens: count('cachedInputTokens'), totalTokens: count('totalTokens'), costUsd: null
  }
}

/** Item IDs reconcile streamed deltas with authoritative item/completed snapshots. */
export class CodexAppServerOutput {
  readonly changedFiles = new Set<string>()
  usage: TaskUsage | undefined
  private baseline: TaskUsage | undefined
  private messages = new Map<string, string>()
  private completed = new Set<string>()
  private readonly tools: ToolOutput
  private readonly textOutput: StreamingTextOutput
  private streamedText = new Map<string, string>()

  constructor(private readonly input: TaskInput, private readonly onEvent: (event: TaskEvent) => void) {
    this.baseline = input.resumeSessionId ? undefined : ZERO_USAGE
    this.tools = new ToolOutput(input, onEvent)
    this.textOutput = new StreamingTextOutput(input, onEvent)
  }

  get output(): string { return [...this.messages.values()].filter(Boolean).join('\n') }

  line(text: string, category: TaskEventCategory, stream: 'stdout' | 'stderr' | 'system' = 'stdout'): void {
    this.onEvent({ type: 'output', event: {
      id: randomUUID(), taskId: this.input.taskId, ts: Date.now(), stream, kind: 'output', category,
      text: text.replace(ANSI, '').replace(/\r$/, '')
    } })
  }

  private delta(key: string, text: string, category: TaskEventCategory): void {
    this.streamedText.set(key, (this.streamedText.get(key) ?? '') + text)
    this.textOutput.append(key, text, category)
  }

  private snapshot(key: string, text: string, category: TaskEventCategory): void {
    const previous = this.streamedText.get(key) ?? ''
    if (text.startsWith(previous)) {
      this.delta(key, text.slice(previous.length), category)
    } else {
      this.flush(key)
      this.line('Codex revised the streamed item; the following text is final.', 'system', 'system')
      this.streamedText.delete(key)
      this.delta(key, text, category)
    }
    this.flush(key)
  }

  flush(key?: string): void {
    this.textOutput.flush(key)
  }

  updateUsage(value: unknown, active: boolean): void {
    const total = tokenUsage(codexObject(value).total)
    if (!active) {
      this.baseline = total
      return
    }
    // `last` is one model request, not an entire turn. A resumed thread needs a
    // pre-turn total; without it, leave usage unknown instead of billing history.
    if (!this.baseline) return
    const usage = { ...ZERO_USAGE }
    for (const key of ['inputTokens', 'outputTokens', 'cachedTokens', 'totalTokens'] as const) {
      if (total[key] < this.baseline[key]) return
      usage[key] = total[key] - this.baseline[key]
    }
    this.usage = usage
    this.onEvent({ type: 'usage', taskId: this.input.taskId, usage })
  }

  notification(method: string, params: CodexObject): void {
    if (method === 'thread/tokenUsage/updated') {
      this.updateUsage(params.tokenUsage, true)
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      this.item(codexObject(params.item), method === 'item/completed')
      return
    }
    if (method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') {
      const id = codexId(params.itemId)
      if (!this.completed.has(id)) this.tools.append(id, codexString(params.delta))
      return
    }
    const categories: Record<string, TaskEventCategory> = {
      'item/agentMessage/delta': 'message',
      'item/reasoning/summaryTextDelta': 'thinking',
      'item/reasoning/textDelta': 'thinking',
      'item/plan/delta': 'system'
    }
    const category = categories[method]
    if (category) {
      const id = codexId(params.itemId)
      if (this.completed.has(id)) return
      const text = codexString(params.delta)
      if (category === 'message') this.messages.set(id, (this.messages.get(id) ?? '') + text)
      const section = method.includes('summary') ? `summary-${params.summaryIndex ?? 0}` : method.includes('reasoning') ? `content-${params.contentIndex ?? 0}` : 'text'
      this.delta(`${id}:${section}`, text, category)
    } else if (method === 'turn/plan/updated') {
      if (typeof params.explanation === 'string') this.line(params.explanation, 'system')
      if (!Array.isArray(params.plan)) throw new Error('Invalid Codex plan')
      for (const value of params.plan) {
        const entry = codexObject(value)
        this.line(`[${codexString(entry.status)}] ${codexString(entry.step)}`, 'system')
      }
    } else if (method === 'error') {
      this.line(codexString(codexObject(params.error).message), 'error')
    }
  }

  item(item: CodexObject, complete: boolean): void {
    const id = codexId(item.id)
    const type = codexString(item.type)
    if (this.completed.has(id)) return
    if (type === 'agentMessage') {
      if (!this.messages.has(id)) this.messages.set(id, '')
      if (complete) {
        const text = codexString(item.text)
        this.messages.set(id, text)
        this.snapshot(`${id}:text`, text, 'message')
      }
    } else if (type === 'reasoning' && complete) {
      for (const [field, section] of [['summary', 'summary'], ['content', 'content']]) {
        const parts = item[field]
        if (Array.isArray(parts)) parts.forEach((text, index) => this.snapshot(`${id}:${section}-${index}`, codexString(text), 'thinking'))
      }
    } else if (type === 'plan' && complete) {
      this.snapshot(`${id}:text`, codexString(item.text), 'system')
    } else if (!['userMessage', 'reasoning', 'plan'].includes(type)) {
      this.flush()
      const name = type === 'commandExecution' ? 'Shell'
        : typeof item.tool === 'string' ? (typeof item.server === 'string' ? `${item.server}/${item.tool}` : item.tool)
        : type === 'fileChange' ? 'Edit files' : type === 'webSearch' ? 'Web search' : type
      const description = typeof item.command === 'string' ? item.command
        : typeof item.query === 'string' ? item.query
        : type === 'fileChange' && Array.isArray(item.changes)
          ? item.changes.map((change) => codexString(codexObject(change).path)).join('\n')
          : toolInputDescription(item.arguments)
      this.tools.use(id, name, description)
      if (complete) {
        const failed = item.status === 'failed' || item.status === 'declined' || item.success === false ||
          (typeof item.exitCode === 'number' && item.exitCode !== 0) || item.error != null
        const result = [
          typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : undefined,
          item.result != null ? (typeof item.result === 'string' ? item.result : JSON.stringify(item.result)) : undefined,
          item.error != null ? (typeof item.error === 'string' ? item.error : JSON.stringify(item.error)) : undefined
        ].filter((text): text is string => text !== undefined)
        this.tools.finish(id, result.length ? result.join('\n') : undefined, `${name}: ${item.status ?? 'completed'}`, failed)
        if (type === 'fileChange' && item.status === 'completed') {
          if (!Array.isArray(item.changes)) throw new Error('Invalid Codex file changes')
          for (const value of item.changes) {
            const change = codexObject(value)
            this.changedFiles.add(codexString(change.path))
            const kind = codexObject(change.kind)
            if (typeof kind.move_path === 'string') this.changedFiles.add(kind.move_path)
          }
        }
      }
    }
    if (complete) this.completed.add(id)
  }
}
