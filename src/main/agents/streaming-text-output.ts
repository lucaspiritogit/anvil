import { randomUUID } from 'node:crypto'
import type { TaskEvent as OutputEvent, TaskEventCategory } from '../../shared/types'
import type { TaskEvent, TaskInput } from './agent-executor'

const ANSI = /\u001b\[[0-9;?]*[ -\/]*[@-~]/g
const PARTIAL_TEXT_FLUSH_MS = 250

interface PendingLine {
  text: string
  category: TaskEventCategory
  dirty: boolean
  event?: OutputEvent
}

/** Publishes complete lines immediately and partial lines on a fixed cadence.
 * Timed snapshots retain their event ID until a newline or explicit flush, so
 * storage and the renderer update the row instead of appending text fragments.
 */
export class StreamingTextOutput {
  private readonly lines = new Map<string, PendingLine>()
  private timer?: ReturnType<typeof setTimeout>

  constructor(private readonly input: TaskInput, private readonly onEvent: (event: TaskEvent) => void) {}

  append(key: string, text: string, category: TaskEventCategory): void {
    if (!text) return
    let line = this.lines.get(key) ?? { text: '', category, dirty: false }
    const parts = text.split('\n')
    for (let index = 0; index < parts.length; index++) {
      line.text += parts[index]
      line.dirty = true
      if (index < parts.length - 1) {
        this.publish(line)
        line = { text: '', category, dirty: false }
      }
    }
    if (line.text) this.lines.set(key, line)
    else this.lines.delete(key)
    this.schedule()
  }

  /** Finish pending lines at a message/tool boundary or when the turn exits. */
  flush(key?: string): void {
    for (const [lineKey, line] of this.lines) {
      if (key !== undefined && key !== lineKey) continue
      this.publish(line)
      this.lines.delete(lineKey)
    }
    this.schedule()
  }

  private schedule(): void {
    if (![...this.lines.values()].some(line => line.dirty)) {
      clearTimeout(this.timer)
      this.timer = undefined
    } else if (!this.timer) {
      // Do not debounce: continuous token arrivals must still become visible.
      this.timer = setTimeout(() => {
        this.timer = undefined
        for (const line of this.lines.values()) if (line.dirty) this.publish(line)
      }, PARTIAL_TEXT_FLUSH_MS)
      this.timer.unref()
    }
  }

  private publish(line: PendingLine): void {
    line.dirty = false
    const text = line.text.replace(ANSI, '').replace(/\r$/, '')
    const previous = line.event
    if (previous?.text === text) return
    const event: OutputEvent = {
      id: previous?.id ?? randomUUID(), taskId: this.input.taskId,
      ts: previous?.ts ?? Date.now(), stream: 'stdout', kind: 'output',
      category: line.category, text
    }
    line.event = event
    this.onEvent({ type: 'output', event })
  }
}
