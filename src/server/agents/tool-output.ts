import { randomUUID } from 'node:crypto'
import type { TaskEvent as OutputEvent } from '../../shared/types'
import type { TaskEvent, TaskInput } from './agent-executor'

const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g

export function toolInputDescription(input: unknown): string {
  if (typeof input === 'string') return input
  if (input == null) return ''
  if (typeof input === 'object' && !Array.isArray(input)) {
    const argumentsObject = input as Record<string, unknown>
    for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'description']) {
      if (typeof argumentsObject[key] === 'string') return argumentsObject[key]
    }
  }
  return JSON.stringify(input)
}

/** Tool snapshots use stable event IDs. Storage and the renderer replace, not append.
 * The first tool_use line is its name; subsequent lines describe its input.
 * Each instance is execution-scoped so reused protocol IDs cannot overwrite history.
 */
export class ToolOutput {
  private readonly calls = new Map<string, { use?: OutputEvent; result?: OutputEvent }>()

  private readonly issueId: string | undefined

  constructor(private readonly input: TaskInput, private readonly onEvent: (event: TaskEvent) => void) {
    this.issueId = input.issueId
  }

  use(callId: string, name: string, description = ''): void {
    this.publish(callId, 'use', `${name.replace(/\s+/g, ' ').trim()}${description ? `\n${description}` : ''}`, false)
    // Reserve the result beside its call even when several tools run concurrently.
    if (!this.calls.get(callId)?.result) this.result(callId, '')
  }

  result(callId: string, text: string, failed = false): void {
    this.publish(callId, 'result', text, failed)
  }

  append(callId: string, text: string): void {
    this.result(callId, (this.calls.get(callId)?.result?.text ?? '') + text)
  }

  finish(callId: string, text: string | undefined, status: string, failed: boolean): void {
    this.result(callId, text ?? (this.calls.get(callId)?.result?.text || status), failed)
  }

  private publish(callId: string, slot: 'use' | 'result', text: string, failed: boolean): void {
    const call = this.calls.get(callId) ?? {}
    const previous = call[slot]
    const category = slot === 'use' ? 'tool_use' : failed ? 'error' : 'tool_result'
    const cleaned = text.replace(ANSI, '').replace(/\r(?=\n|$)/g, '')
    if (previous?.text === cleaned && previous.category === category) return
    const event: OutputEvent = {
      id: previous?.id ?? `tool-${slot}:${randomUUID()}`, taskId: this.input.taskId, issueId: this.issueId,
      ts: previous?.ts ?? Date.now(), stream: failed ? 'stderr' : 'stdout',
      kind: 'output', category, text: cleaned
    }
    call[slot] = event
    this.calls.set(callId, call)
    this.onEvent({ type: 'output', event })
  }
}
