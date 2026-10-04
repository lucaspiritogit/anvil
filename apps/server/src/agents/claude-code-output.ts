import { randomUUID } from 'node:crypto'
import { contextOccupancy, CONTEXT_COMPACTED } from '@anvil/protocol/task-context'
import type { TaskEventCategory, TaskUsage } from '@anvil/protocol/types'
import type { TaskEvent, TaskInput } from './agent-executor'
import { StreamingTextOutput } from './streaming-text-output'
import { ToolOutput, toolInputDescription } from './tool-output'

type ClaudeObject = Record<string, unknown>

interface ClaudeContentBlock {
  type: string
  toolId?: string
  completed: boolean
}

export function claudeObject(value: unknown): ClaudeObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ClaudeObject : {}
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function modelUsage(value: unknown): TaskUsage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const usage: TaskUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null }
  for (const model of Object.values(value)) {
    const fields = claudeObject(model)
    const input = tokenCount(fields.inputTokens)
    const output = tokenCount(fields.outputTokens)
    const cachedRead = tokenCount(fields.cacheReadInputTokens)
    const cachedWrite = tokenCount(fields.cacheCreationInputTokens)
    if (input === undefined || output === undefined || cachedRead === undefined || cachedWrite === undefined) return undefined
    usage.inputTokens += input
    usage.outputTokens += output
    usage.cachedTokens += cachedRead + cachedWrite
  }
  usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cachedTokens
  return usage
}

export class ClaudeCodeOutput {
  readonly changedFiles = new Set<string>()
  usage: TaskUsage | undefined
  private readonly textOutput: StreamingTextOutput
  private readonly tools: ToolOutput
  private readonly messages = new Map<string, Map<number, string>>()
  private readonly blocks = new Map<string, Map<number, ClaudeContentBlock>>()
  private readonly snapshots = new Set<string>()
  private readonly streamed = new Map<string, string>()
  private readonly completed = new Set<string>()
  private readonly toolInputs = new Map<string, { name: string; input: ClaudeObject }>()
  private readonly compacted = new Set<string>()
  private streamMessageId?: string
  private baseline?: TaskUsage
  private fallbackOutput = ''

  constructor(private readonly input: TaskInput, private readonly onEvent: (event: TaskEvent) => void) {
    this.textOutput = new StreamingTextOutput(input, onEvent)
    this.tools = new ToolOutput(input, onEvent)
  }

  get output(): string {
    const messages = [...this.messages.values()].flatMap((blocks) => [...blocks.entries()]
      .sort(([left], [right]) => left - right).map(([, text]) => text).filter(Boolean))
    return messages.length > 0 ? messages.join('\n') : this.fallbackOutput
  }

  line(text: string, category: TaskEventCategory, stream: 'stdout' | 'stderr' | 'system' = 'stdout'): void {
    this.onEvent({ type: 'output', event: {
      id: randomUUID(), taskId: this.input.taskId, issueId: this.input.issueId, ts: Date.now(),
      stream, kind: 'output', category, text
    } })
  }

  setUsageBaseline(value: unknown): void {
    this.baseline = modelUsage(value)
  }

  updateContext(value: unknown): void {
    const context = claudeObject(value)
    this.onEvent({ type: 'context', taskId: this.input.taskId, ...contextOccupancy(context.totalTokens, context.maxTokens) })
  }

  flush(): void {
    this.textOutput.flush()
  }

  message(message: ClaudeObject): void {
    if (message.historical === true || message.isReplay === true) return
    if (message.type === 'stream_event') {
      this.streamEvent(message)
    } else if (message.type === 'assistant') {
      this.assistant(message)
    } else if (message.type === 'user') {
      this.toolResults(message)
    } else if (message.type === 'system' && message.subtype === 'compact_boundary') {
      const key = typeof message.uuid === 'string' ? message.uuid : JSON.stringify(message.compact_metadata)
      if (this.compacted.has(key)) return
      this.compacted.add(key)
      const metadata = claudeObject(message.compact_metadata)
      this.onEvent({ type: 'context', taskId: this.input.taskId, ...contextOccupancy(metadata.post_tokens, undefined) })
      this.line(CONTEXT_COMPACTED, 'system', 'system')
    } else if (message.type === 'result') {
      this.finishUsage(message.modelUsage)
      if (!this.input.compactOnly && typeof message.result === 'string') this.fallbackOutput = message.result
      this.flush()
    }
  }

  private finishUsage(value: unknown): void {
    const total = modelUsage(value)
    if (!total || !this.baseline) return
    const usage: TaskUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null }
    for (const key of ['inputTokens', 'outputTokens', 'cachedTokens', 'totalTokens'] as const) {
      if (total[key] < this.baseline[key]) return
      usage[key] = total[key] - this.baseline[key]
    }
    this.usage = usage
    this.onEvent({ type: 'usage', taskId: this.input.taskId, usage })
  }

  private append(key: string, text: string, category: 'message' | 'thinking'): void {
    if (this.completed.has(key)) return
    this.streamed.set(key, (this.streamed.get(key) ?? '') + text)
    this.textOutput.append(key, text, category)
  }

  private appendStream(messageId: string, index: number, text: string, category: 'message' | 'thinking'): void {
    const key = `${messageId}:${index}`
    if (this.completed.has(key)) return
    this.append(key, text, category)
    if (category !== 'message') return
    const blocks = this.messages.get(messageId) ?? new Map<number, string>()
    blocks.set(index, this.streamed.get(key) ?? '')
    this.messages.set(messageId, blocks)
  }

  private snapshot(key: string, text: string, category: 'message' | 'thinking'): void {
    if (this.completed.has(key)) return
    const previous = this.streamed.get(key) ?? ''
    if (text.startsWith(previous)) {
      this.append(key, text.slice(previous.length), category)
    } else {
      this.textOutput.flush(key)
      this.line('Claude revised the streamed message. The following text is final.', 'system', 'system')
      this.textOutput.append(key, text, category)
    }
    this.textOutput.flush(key)
    this.completed.add(key)
  }

  private streamEvent(message: ClaudeObject): void {
    const event = claudeObject(message.event)
    if (event.type === 'message_start') {
      if (message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined) return
      const started = claudeObject(event.message)
      this.streamMessageId = typeof started.id === 'string' ? started.id : undefined
      return
    }
    const messageId = this.streamMessageId
    if (!messageId || message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined) return
    const index = typeof event.index === 'number' ? event.index : 0
    if (event.type === 'content_block_start') {
      const block = claudeObject(event.content_block)
      if (typeof block.type === 'string') {
        const blocks = this.blocks.get(messageId) ?? new Map<number, ClaudeContentBlock>()
        blocks.set(index, { type: block.type, toolId: typeof block.id === 'string' ? block.id : undefined, completed: false })
        this.blocks.set(messageId, blocks)
      }
      if (block.type === 'text' && typeof block.text === 'string') this.appendStream(messageId, index, block.text, 'message')
      if (block.type === 'thinking' && typeof block.thinking === 'string') this.appendStream(messageId, index, block.thinking, 'thinking')
      if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        this.flush()
        this.tools.use(block.id, block.name, toolInputDescription(block.input))
      }
    } else if (event.type === 'content_block_delta') {
      const delta = claudeObject(event.delta)
      if (delta.type === 'text_delta' && typeof delta.text === 'string') this.appendStream(messageId, index, delta.text, 'message')
      if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') this.appendStream(messageId, index, delta.thinking, 'thinking')
    }
  }

  private assistant(message: ClaudeObject): void {
    const assistant = claudeObject(message.message)
    const id = typeof assistant.id === 'string' ? assistant.id : typeof message.uuid === 'string' ? message.uuid : undefined
    if (!id || !Array.isArray(assistant.content)) return
    if (typeof message.uuid === 'string') {
      if (this.snapshots.has(message.uuid)) return
      this.snapshots.add(message.uuid)
    }
    const mainAgent = message.parent_tool_use_id === null || message.parent_tool_use_id === undefined
    const multiple = assistant.content.length > 1
    assistant.content.forEach((value, position) => {
      const block = claudeObject(value)
      const index = this.contentBlockIndex(id, block, position, multiple)
      if (block.type === 'text' && typeof block.text === 'string' && mainAgent) {
        this.snapshot(`${id}:${index}`, block.text, 'message')
        const text = this.messages.get(id) ?? new Map<number, string>()
        text.set(index, block.text)
        this.messages.set(id, text)
      } else if (block.type === 'thinking' && typeof block.thinking === 'string' && mainAgent) {
        this.snapshot(`${id}:${index}`, block.thinking, 'thinking')
      } else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        this.flush()
        this.toolInputs.set(block.id, { name: block.name, input: claudeObject(block.input) })
        this.tools.use(block.id, block.name, toolInputDescription(block.input))
      }
    })
  }

  private contentBlockIndex(messageId: string, block: ClaudeObject, position: number, multiple: boolean): number {
    const blocks = this.blocks.get(messageId) ?? new Map<number, ClaudeContentBlock>()
    const type = typeof block.type === 'string' ? block.type : 'unknown'
    const toolId = typeof block.id === 'string' ? block.id : undefined
    const matches = (candidate: ClaudeContentBlock): boolean => candidate.type === type &&
      (type !== 'tool_use' || candidate.toolId === toolId)
    const positioned = multiple ? blocks.get(position) : undefined
    let index = positioned && matches(positioned) ? position : [...blocks.entries()]
      .filter(([, candidate]) => !candidate.completed && matches(candidate))
      .sort(([left], [right]) => left - right)[0]?.[0]
    if (index === undefined) index = multiple && !blocks.has(position) ? position : Math.max(-1, ...blocks.keys()) + 1
    blocks.set(index, { type, toolId, completed: true })
    this.blocks.set(messageId, blocks)
    return index
  }

  private toolResults(message: ClaudeObject): void {
    const user = claudeObject(message.message)
    if (!Array.isArray(user.content)) return
    for (const value of user.content) {
      const block = claudeObject(value)
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const content = typeof block.content === 'string' ? block.content : Array.isArray(block.content)
        ? block.content.map((part) => {
          const fields = claudeObject(part)
          return typeof fields.text === 'string' ? fields.text : JSON.stringify(part)
        }).join('\n') : undefined
      const failed = block.is_error === true
      this.tools.finish(block.tool_use_id, content, failed ? 'Tool failed' : 'Tool completed', failed)
      const tool = this.toolInputs.get(block.tool_use_id)
      if (failed || !tool || !['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool.name)) continue
      const path = tool.input.file_path ?? tool.input.notebook_path
      if (typeof path === 'string') this.changedFiles.add(path)
    }
  }
}
