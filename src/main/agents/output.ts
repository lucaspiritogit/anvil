import type {
  AgentDefinition,
  TaskEventCategory,
  TaskUsage,
  StreamName
} from '../../shared/types'

type JsonObject = Record<string, unknown>

/** One rendered line of agent output, already classified for the task log. */
export interface ParsedAgentPart {
  text: string
  category: TaskEventCategory
  stream: StreamName
}

export interface ParsedAgentLine {
  parts: ParsedAgentPart[]
  usage?: Partial<TaskUsage>
  usageMode?: 'add' | 'set'
  /** Agent session this line belongs to, when the protocol reports one. */
  sessionId?: string
}

const NOTHING: ParsedAgentLine = { parts: [] }

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

function part(
  text: string | undefined,
  category: TaskEventCategory,
  stream: StreamName = 'stdout'
): ParsedAgentPart[] {
  return text ? [{ text, category, stream }] : []
}

function line(
  text: string | undefined,
  category: TaskEventCategory,
  stream: StreamName = 'stdout'
): ParsedAgentLine {
  return { parts: part(text, category, stream) }
}

/** Compact preview of a tool's arguments, so a tool_use line says what it did. */
function toolSummary(name: string | undefined, input: unknown): string | undefined {
  if (!name) return undefined
  const args = object(input)
  const detail =
    string(args?.command) ??
    string(args?.file_path) ??
    string(args?.path) ??
    string(args?.pattern) ??
    string(args?.query) ??
    string(args?.description)
  if (!detail) return name
  const flat = detail.replace(/\s+/g, ' ').trim()
  return `${name} · ${flat.length > 160 ? `${flat.slice(0, 159)}…` : flat}`
}

function blockText(block: JsonObject): string | undefined {
  return (
    string(block.text) ??
    string(block.thinking) ??
    string(block.content) ??
    (Array.isArray(block.content) ? contentParts(block.content, 'tool_result')[0]?.text : undefined)
  )
}

/**
 * Walks a message's content blocks, mapping each block type onto a category.
 * Block names differ between agents (`tool_use` / `toolUse`, `thinking` /
 * `reasoning`), so both spellings are accepted. `fallback` is the category for
 * plain text blocks, which is `message` for an assistant turn and
 * `tool_result` for a tool-result turn.
 */
function contentParts(value: unknown, fallback: TaskEventCategory): ParsedAgentPart[] {
  if (typeof value === 'string') return part(string(value), fallback)
  if (!Array.isArray(value)) return []

  return value.flatMap((entry) => {
    const block = object(entry)
    if (!block) return string(entry) ? part(string(entry), fallback) : []

    const type = string(block.type)?.toLowerCase()
    if (type === 'thinking' || type === 'reasoning') {
      return part(blockText(block), 'thinking')
    }
    if (type === 'redacted_thinking') {
      return part('(redacted thinking)', 'thinking')
    }
    if (type === 'tool_use' || type === 'tooluse' || type === 'tool_call') {
      return part(
        toolSummary(string(block.name) ?? string(block.toolName), block.input ?? block.arguments),
        'tool_use'
      )
    }
    if (type === 'tool_result' || type === 'toolresult') {
      const failed = block.is_error === true || block.isError === true
      return part(blockText(block), failed ? 'error' : 'tool_result', failed ? 'stderr' : 'stdout')
    }
    if (type === 'text' || type === undefined) {
      return part(blockText(block), fallback)
    }
    return []
  })
}

function parseOpenCode(event: JsonObject): ParsedAgentLine {
  const eventPart = object(event.part)
  if (event.type === 'text') return line(string(eventPart?.text), 'message')
  if (event.type === 'reasoning') return line(string(eventPart?.text), 'thinking')
  if (event.type === 'tool_use') {
    const state = object(eventPart?.state)
    const title = string(state?.title) ?? string(eventPart?.tool)
    const failed = state?.status === 'error'
    if (failed) return line(title ? `Failed ${title}` : undefined, 'error', 'stderr')
    return line(title, 'tool_use')
  }
  if (event.type === 'tool_result') {
    const state = object(eventPart?.state)
    return line(string(state?.output) ?? string(eventPart?.output), 'tool_result')
  }
  if (event.type === 'error') {
    const error = object(event.error)
    const data = object(error?.data)
    return line(
      string(data?.message) ?? string(error?.message) ?? 'OpenCode failed',
      'error',
      'stderr'
    )
  }
  if (event.type !== 'step_finish') return NOTHING

  const tokens = object(eventPart?.tokens)
  const cache = object(tokens?.cache)
  const inputTokens = number(tokens?.input)
  const outputTokens = number(tokens?.output) + number(tokens?.reasoning)
  const cachedTokens = number(cache?.read) + number(cache?.write)
  return {
    parts: [],
    usageMode: 'add',
    usage: {
      inputTokens,
      outputTokens,
      cachedTokens,
      totalTokens: number(tokens?.total) || inputTokens + outputTokens + cachedTokens,
      costUsd: number(eventPart?.cost)
    }
  }
}

function parseCodex(event: JsonObject): ParsedAgentLine {
  if (event.type === 'item.completed') {
    const item = object(event.item)
    const itemType = item?.type
    if (itemType === 'agent_message') return line(string(item?.text), 'message')
    if (itemType === 'reasoning') {
      return line(string(item?.text) ?? string(item?.summary), 'thinking')
    }
    if (itemType === 'command_execution') {
      return {
        parts: [
          ...part(string(item?.command), 'tool_use'),
          ...part(string(item?.aggregated_output), 'tool_result')
        ]
      }
    }
    if (itemType === 'file_change') {
      return line(toolSummary('file_change', item), 'tool_use')
    }
    if (itemType === 'mcp_tool_call') {
      return line(toolSummary(string(item?.tool) ?? 'mcp_tool_call', item?.arguments), 'tool_use')
    }
    if (itemType === 'error') return line(string(item?.message), 'error', 'stderr')
  }
  if (event.type !== 'turn.completed') return NOTHING

  const usage = object(event.usage)
  const inputTokens = number(usage?.input_tokens)
  const outputTokens = number(usage?.output_tokens)
  const cachedTokens = number(usage?.cached_input_tokens)
  return {
    parts: [],
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
    if (!name) return NOTHING
    return failed ? line(`Failed ${name}`, 'error', 'stderr') : line(name, 'tool_use')
  }
  if (event.type === 'thinking' || event.type === 'reasoning') {
    return line(string(event.text) ?? string(event.thinking), 'thinking')
  }
  if (event.type === 'error') {
    return line(string(event.message) ?? 'Pi reported an error', 'error', 'stderr')
  }
  if (event.type !== 'message_end') return NOTHING

  const message = object(event.message)
  const role = message?.role
  if (role !== 'assistant' && role !== 'toolResult') return NOTHING

  const parts = contentParts(message?.content, role === 'assistant' ? 'message' : 'tool_result')
  const usage = object(message?.usage)
  if (!usage) return { parts }

  const cost = object(usage.cost)
  const inputTokens = number(usage.input)
  const outputTokens = number(usage.output)
  const cachedTokens = number(usage.cacheRead) + number(usage.cacheWrite)
  return {
    parts,
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

const SESSION_KEYS = ['sessionID', 'session_id', 'sessionId']

/**
 * Pulls the agent's session id out of an event, wherever the protocol puts it.
 * Agents spell and nest it differently (opencode `part.sessionID`, Codex
 * `session_id` at the top level), so this walks a couple of levels rather than
 * encoding one shape per protocol.
 */
function findSessionId(value: unknown, depth = 0): string | undefined {
  const node = object(value)
  if (!node || depth > 3) return undefined
  for (const key of SESSION_KEYS) {
    const found = string(node[key])
    if (found) return found
  }
  for (const nested of Object.values(node)) {
    const found = findSessionId(nested, depth + 1)
    if (found) return found
  }
  return undefined
}

export function parseAgentLine(
  protocol: NonNullable<AgentDefinition['outputProtocol']>,
  rawLine: string
): ParsedAgentLine {
  let event: JsonObject
  try {
    const value = object(JSON.parse(rawLine))
    if (!value) return line(rawLine, 'message')
    event = value
  } catch {
    // Not JSON: an agent writing plain text through its JSON stream.
    return line(rawLine, 'message')
  }

  const parsed =
    protocol === 'opencode-json'
      ? parseOpenCode(event)
      : protocol === 'codex-json'
        ? parseCodex(event)
        : parsePi(event)

  const sessionId = findSessionId(event)
  return sessionId ? { ...parsed, sessionId } : parsed
}
