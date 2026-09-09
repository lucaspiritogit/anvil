import { randomUUID } from 'node:crypto'
import type { SessionUpdate, ToolCall, ToolCallUpdate, Usage } from '@agentclientprotocol/sdk'
import type { TaskEventCategory, TaskUsage } from '../../shared/types'
import type { TaskEvent, TaskInput } from './agent-client-protocol'
import { ToolOutput, toolInputDescription } from './tool-output'
import { StreamingTextOutput } from './streaming-text-output'

const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g

/** Converts ACP message chunks and tool snapshots to Anvil output events. */
export class AcpOutput {
  output = ''
  usage: TaskUsage | undefined
  readonly changedFiles = new Set<string>()
  private tools = new Map<string, ToolCallUpdate>()
  private readonly toolOutput: ToolOutput
  private readonly textOutput: StreamingTextOutput
  private messageIds = new Map<'message' | 'thinking', string>()
  private activeCategory?: 'message' | 'thinking'
  private costUsd: number | null = null

  private readonly issueId: string | undefined

  constructor(private readonly input: TaskInput, private readonly onEvent: (event: TaskEvent) => void) {
    this.issueId = input.issueId
    this.toolOutput = new ToolOutput(input, onEvent)
    this.textOutput = new StreamingTextOutput(input, onEvent)
  }

  line(text: string, category: TaskEventCategory, stream: 'stdout' | 'stderr' | 'system' = 'stdout'): void {
    this.onEvent({
      type: 'output',
      event: {
        id: randomUUID(), taskId: this.input.taskId, issueId: this.issueId, ts: Date.now(), kind: 'output',
        stream, category, text: text.replace(ANSI, '').replace(/\r$/, '')
      }
    })
  }

  flush(): void {
    this.textOutput.flush()
    this.activeCategory = undefined
  }

  update(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        if (update.content.type !== 'text') return
        const category = update.sessionUpdate === 'agent_message_chunk' ? 'message' : 'thinking'
        const previousMessageId = this.messageIds.get(category)
        const messageChanged = update.messageId && previousMessageId && update.messageId !== previousMessageId
        // ACP chunks can omit messageId. A thought/message transition still
        // closes the previous stream so delayed snapshots cannot reorder it.
        if (messageChanged || (this.activeCategory && this.activeCategory !== category)) this.flush()
        if (messageChanged && category === 'message' && !this.output.endsWith('\n')) this.output += '\n'
        this.activeCategory = category
        if (update.messageId) this.messageIds.set(category, update.messageId)
        if (category === 'message') this.output += update.content.text
        this.textOutput.append(category, update.content.text, category)
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
    const current: ToolCallUpdate = {
      ...previous,
      ...Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined)),
      toolCallId: update.toolCallId
    }
    // ACP defines a null programmatic name as unchanged, not cleared.
    current.name = update.name ?? previous?.name
    this.tools.set(update.toolCallId, current)
    const name = current.name ?? current.title ?? current.kind ?? update.toolCallId
    const description = toolInputDescription(current.rawInput) ||
      (current.locations ?? []).map((location) => location.path).join('\n') ||
      (current.title !== name ? current.title ?? '' : '')
    this.toolOutput.use(update.toolCallId, name, description)
    const textContent = (current.content ?? []).flatMap((content) =>
      content.type === 'content' && content.content.type === 'text' ? [content.content.text] : []
    )
    const terminal = current.status === 'completed' || current.status === 'failed'
    if (textContent.length || current.rawOutput != null || terminal) {
      const text = textContent.length ? textContent.join('\n')
        : current.rawOutput != null ? (typeof current.rawOutput === 'string' ? current.rawOutput : JSON.stringify(current.rawOutput))
        : `${name}: ${current.status}`
      this.toolOutput.result(update.toolCallId, text, current.status === 'failed')
    }
    for (const content of current.content ?? []) {
      if (content.type === 'diff' && current.status === 'completed') this.changedFiles.add(content.path)
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
