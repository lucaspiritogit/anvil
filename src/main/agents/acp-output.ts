import { randomUUID } from 'node:crypto'
import type { SessionUpdate, ToolCall, ToolCallUpdate, Usage } from '@agentclientprotocol/sdk'
import type { TaskEventCategory, TaskUsage } from '../../shared/types'
import type { TaskEvent, TaskInput } from './agent-client-protocol'

const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g

/** Converts ACP chunks and tool patches to Anvil's append-only, line-based output. */
export class AcpOutput {
  output = ''
  usage: TaskUsage | undefined
  readonly changedFiles = new Set<string>()
  private buffers = new Map<TaskEventCategory, string>()
  private tools = new Map<string, ToolCallUpdate>()
  private messageId: string | undefined
  private costUsd: number | null = null

  constructor(private readonly input: TaskInput, private readonly onEvent: (event: TaskEvent) => void) {}

  line(text: string, category: TaskEventCategory, stream: 'stdout' | 'stderr' | 'system' = 'stdout'): void {
    this.onEvent({
      type: 'output',
      event: {
        id: randomUUID(), taskId: this.input.taskId, ts: Date.now(), kind: 'output',
        stream, category, text: text.replace(ANSI, '').replace(/\r$/, '')
      }
    })
  }

  private chunk(text: string, category: TaskEventCategory): void {
    const lines = ((this.buffers.get(category) ?? '') + text).split('\n')
    this.buffers.set(category, lines.pop() ?? '')
    for (const line of lines) this.line(line, category)
  }

  flush(): void {
    for (const [category, text] of this.buffers) {
      if (text) this.line(text, category)
    }
    this.buffers.clear()
  }

  update(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        if (update.content.type !== 'text') return
        const category = update.sessionUpdate === 'agent_message_chunk' ? 'message' : 'thinking'
        if (category === 'message') {
          if (update.messageId && this.messageId && update.messageId !== this.messageId) {
            this.flush()
            if (!this.output.endsWith('\n')) this.output += '\n'
          }
          this.messageId = update.messageId ?? this.messageId
          this.output += update.content.text
        }
        this.chunk(update.content.text, category)
        break
      }
      case 'tool_call':
      case 'tool_call_update':
        this.flush()
        this.tool(update)
        break
      case 'plan':
        for (const entry of update.entries) this.line(`[${entry.status}] ${entry.content}`, 'system')
        break
      case 'usage_update':
        // ACP's `used` is context occupancy, not billable token usage. Cost is
        // session-cumulative; without a resume baseline it cannot be charged again.
        if (!this.input.resumeSessionId && update.cost?.currency === 'USD') {
          this.costUsd = update.cost.amount
        }
        break
    }
  }

  private tool(update: ToolCall | ToolCallUpdate): void {
    const previous = this.tools.get(update.toolCallId)
    const current = { ...previous, ...update }
    this.tools.set(update.toolCallId, current)
    if (!previous || (update.title && update.title !== previous.title)) {
      this.line(current.title ?? update.toolCallId, 'tool_use')
    }
    if (update.rawInput != null && JSON.stringify(update.rawInput) !== JSON.stringify(previous?.rawInput)) {
      this.line(JSON.stringify(update.rawInput), 'tool_use')
    }
    if (current.status !== 'completed' && current.status !== 'failed') return
    if (previous?.status === current.status && update.content === undefined && update.rawOutput === undefined) return
    const category = current.status === 'failed' ? 'error' : 'tool_result'
    this.line(`${current.title ?? update.toolCallId}: ${current.status}`, category)
    for (const content of current.content ?? []) {
      if (content.type === 'content' && content.content.type === 'text') {
        for (const line of content.content.text.split('\n')) this.line(line, category)
      }
      if (content.type === 'diff' && current.status === 'completed') this.changedFiles.add(content.path)
    }
    const hasTextContent = current.content?.some((content) => content.type === 'content' && content.content.type === 'text')
    if (!hasTextContent && current.rawOutput != null) {
      const text = typeof current.rawOutput === 'string' ? current.rawOutput : JSON.stringify(current.rawOutput)
      for (const line of text.split('\n')) this.line(line, category)
    }
    if (current.status === 'completed' && ['edit', 'delete', 'move'].includes(current.kind ?? '')) {
      for (const location of current.locations ?? []) this.changedFiles.add(location.path)
    }
  }

  finishUsage(usage?: Usage | null): void {
    if (!usage && this.costUsd === null) return
    this.usage = {
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cachedTokens: usage?.cachedReadTokens ?? 0,
      totalTokens: usage?.totalTokens ?? 0,
      costUsd: this.costUsd
    }
    this.onEvent({ type: 'usage', taskId: this.input.taskId, usage: this.usage })
  }
}
