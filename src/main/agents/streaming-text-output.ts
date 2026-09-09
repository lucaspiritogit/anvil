import { randomUUID } from 'node:crypto'
import type { TaskEvent as OutputEvent, TaskEventCategory } from '../../shared/types'
import type { TaskEvent, TaskInput } from './agent-executor'

const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g
const PARTIAL_TEXT_FLUSH_MS = 250

interface PendingText {
  text: string
  category: TaskEventCategory
  dirty: boolean
  event?: OutputEvent
}

/** Publishes one evolving event per protocol text stream, not per newline.
 * Paragraph breaks stay inside its text. Only an adapter's message/item/tool
 * boundary or turn completion closes the event; timed snapshots keep its ID.
 */
export class StreamingTextOutput {
  private readonly streams = new Map<string, PendingText>()
  private timer?: ReturnType<typeof setTimeout>

  private readonly issueId: string | undefined

  constructor(private readonly input: TaskInput, private readonly onEvent: (event: TaskEvent) => void) {
    this.issueId = input.issueId
  }

  append(key: string, text: string, category: TaskEventCategory): void {
    if (!text) return
    const pending = this.streams.get(key) ?? { text: '', category, dirty: false }
    pending.text += text
    pending.dirty = true
    this.streams.set(key, pending)
    this.schedule()
  }

  /** Finish selected streams at a protocol boundary or when the turn exits. */
  flush(key?: string): void {
    for (const [streamKey, pending] of this.streams) {
      if (key !== undefined && key !== streamKey) continue
      this.publish(pending)
      this.streams.delete(streamKey)
    }
    this.schedule()
  }

  private schedule(): void {
    if (![...this.streams.values()].some(pending => pending.dirty)) {
      clearTimeout(this.timer)
      this.timer = undefined
    } else if (!this.timer) {
      // Do not debounce: continuous token arrivals must still become visible.
      this.timer = setTimeout(() => {
        this.timer = undefined
        for (const pending of this.streams.values()) if (pending.dirty) this.publish(pending)
      }, PARTIAL_TEXT_FLUSH_MS)
      this.timer.unref()
    }
  }

  private publish(pending: PendingText): void {
    pending.dirty = false
    const text = pending.text.replace(ANSI, '').replace(/\r(?=\n|$)/g, '')
    const previous = pending.event
    // Keep leading whitespace buffered until content arrives. Do not trim the
    // text itself: indentation and paragraph breaks belong to the message.
    if ((!previous && !text.trim()) || previous?.text === text) return
    const event: OutputEvent = {
      id: previous?.id ?? randomUUID(), taskId: this.input.taskId, issueId: this.issueId,
      ts: previous?.ts ?? Date.now(), stream: 'stdout', kind: 'output',
      category: pending.category, text
    }
    pending.event = event
    this.onEvent({ type: 'output', event })
  }
}
