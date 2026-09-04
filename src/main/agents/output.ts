import type { AgentDefinition, RunUsage, StreamName } from '../../shared/types'

type JsonObject = Record<string, unknown>

export interface ParsedAgentLine {
  text?: string
  stream?: StreamName
  usage?: Partial<RunUsage>
  usageMode?: 'add' | 'set'
}

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined
}

function contentText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const text = value
    .flatMap((entry) => {
      const part = object(entry)
      if (!part || part.type !== 'text') return []
      const value = string(part.text)
      return value ? [value] : []
    })
    .join('\n')
  return text || undefined
}

function parseOpenCode(event: JsonObject): ParsedAgentLine {
  const part = object(event.part)
  if (event.type === 'text') return { text: string(part?.text) }
  if (event.type === 'reasoning') {
    const text = string(part?.text)
    return { text: text ? `Thinking: ${text}` : undefined }
  }
  if (event.type === 'tool_use') {
    const state = object(part?.state)
    const title = string(state?.title) ?? string(part?.tool)
    const failed = state?.status === 'error'
    return { text: title ? `${failed ? 'Failed' : 'Ran'} ${title}` : undefined, stream: failed ? 'stderr' : 'stdout' }
  }
  if (event.type === 'error') {
    const error = object(event.error)
    const data = object(error?.data)
    return { text: string(data?.message) ?? string(error?.message) ?? 'OpenCode failed', stream: 'stderr' }
  }
  if (event.type !== 'step_finish') return {}

  const tokens = object(part?.tokens)
  const cache = object(tokens?.cache)
  const inputTokens = number(tokens?.input)
  const outputTokens = number(tokens?.output) + number(tokens?.reasoning)
  const cachedTokens = number(cache?.read) + number(cache?.write)
  return {
    usageMode: 'add',
    usage: {
      inputTokens,
      outputTokens,
      cachedTokens,
      totalTokens: number(tokens?.total) || inputTokens + outputTokens + cachedTokens,
      costUsd: number(part?.cost)
    }
  }
}

function parseClaude(event: JsonObject): ParsedAgentLine {
  if (event.type === 'assistant') {
    const message = object(event.message)
    return { text: contentText(message?.content) }
  }
  if (event.type !== 'result') return {}

  const usage = object(event.usage)
  const inputTokens = number(usage?.input_tokens)
  const outputTokens = number(usage?.output_tokens)
  const cachedTokens =
    number(usage?.cache_creation_input_tokens) + number(usage?.cache_read_input_tokens)
  return {
    usageMode: 'set',
    usage: {
      inputTokens,
      outputTokens,
      cachedTokens,
      totalTokens: inputTokens + outputTokens + cachedTokens,
      costUsd: typeof event.total_cost_usd === 'number' ? event.total_cost_usd : null
    }
  }
}

function parseCodex(event: JsonObject): ParsedAgentLine {
  if (event.type === 'item.completed') {
    const item = object(event.item)
    const itemType = item?.type
    if (itemType === 'agent_message') return { text: string(item?.text) }
    if (itemType === 'command_execution') return { text: string(item?.aggregated_output) }
    if (itemType === 'error') return { text: string(item?.message), stream: 'stderr' }
  }
  if (event.type !== 'turn.completed') return {}

  const usage = object(event.usage)
  const inputTokens = number(usage?.input_tokens)
  const outputTokens = number(usage?.output_tokens)
  const cachedTokens = number(usage?.cached_input_tokens)
  return {
    usageMode: 'set',
    usage: {
      inputTokens,
      outputTokens,
      cachedTokens,
      totalTokens: number(usage?.total_tokens) || inputTokens + outputTokens,
      costUsd: null
    }
  }
}

function parsePi(event: JsonObject): ParsedAgentLine {
  if (event.type === 'tool_execution_end') {
    const failed = event.isError === true
    const name = string(event.toolName)
    return { text: name ? `${failed ? 'Failed' : 'Ran'} ${name}` : undefined, stream: failed ? 'stderr' : 'stdout' }
  }
  if (event.type !== 'message_end') return {}

  const message = object(event.message)
  if (message?.role !== 'assistant' && message?.role !== 'toolResult') return {}
  const usage = object(message.usage)
  if (!usage) return {}
  const cost = object(usage.cost)
  const inputTokens = number(usage.input)
  const outputTokens = number(usage.output)
  const cachedTokens = number(usage.cacheRead) + number(usage.cacheWrite)
  return {
    text: message.role === 'assistant' ? contentText(message.content) : undefined,
    usageMode: 'add',
    usage: {
      inputTokens,
      outputTokens,
      cachedTokens,
      totalTokens: number(usage.totalTokens) || inputTokens + outputTokens + cachedTokens,
      costUsd: typeof cost?.total === 'number' ? cost.total : null
    }
  }
}

export function parseAgentLine(
  protocol: NonNullable<AgentDefinition['outputProtocol']>,
  line: string
): ParsedAgentLine {
  let event: JsonObject
  try {
    const value = object(JSON.parse(line))
    if (!value) return { text: line }
    event = value
  } catch {
    return { text: line }
  }

  if (protocol === 'opencode-json') return parseOpenCode(event)
  if (protocol === 'claude-json') return parseClaude(event)
  if (protocol === 'codex-json') return parseCodex(event)
  return parsePi(event)
}
