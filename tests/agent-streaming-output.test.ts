import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { AcpOutput } from '../src/main/agents/acp-output'
import { CodexAppServerOutput } from '../src/main/agents/codex-app-server-output'
import type { TaskEvent, TaskInput } from '../src/main/agents/agent-executor'

const input: TaskInput = { taskId: 'streaming-output', prompt: 'hello', cwd: '/tmp' }
const flushIntervalMs = 250

for (const protocol of ['acp', 'codex'] as const) {
  const events: TaskEvent[] = []
  const record = (event: TaskEvent): void => { events.push(event) }
  const output = protocol === 'acp' ? new AcpOutput(input, record) : new CodexAppServerOutput(input, record)
  const rows = () => [...new Map(events.flatMap(event => event.type === 'output' ? [[event.event.id, event.event] as const] : [])).values()]
  const append = (text: string, category: 'message' | 'thinking' = 'message', messageId = 'first'): void => {
    if (output instanceof AcpOutput) {
      output.update({ sessionUpdate: category === 'message' ? 'agent_message_chunk' : 'agent_thought_chunk', messageId, content: { type: 'text', text } })
    } else {
      output.notification(category === 'message' ? 'item/agentMessage/delta' : 'item/reasoning/textDelta', { itemId: messageId, delta: text })
    }
  }

  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 })
  try {
    append('Hel')
    mock.timers.tick(100)
    append('lo')
    mock.timers.tick(149)
    assert.equal(rows().length, 0, `${protocol}: coalesce small deltas before publishing`)
    mock.timers.tick(1)
    assert.deepEqual(rows().map(row => row.text), ['Hello'], `${protocol}: show partial text within 250 ms without a newline`)
    const partial = rows()[0]

    append(' world')
    mock.timers.tick(flushIntervalMs)
    assert.equal(rows().length, 1, `${protocol}: update the partial row, do not append a fragment`)
    assert.equal(rows()[0].id, partial.id)
    assert.equal(rows()[0].ts, partial.ts)
    assert.equal(rows()[0].text, 'Hello world')

    append('!\nSecond line\nThird')
    assert.deepEqual(rows().map(row => row.text), ['Hello world!', 'Second line'])
    mock.timers.tick(flushIntervalMs)
    assert.deepEqual(rows().map(row => row.text), ['Hello world!', 'Second line', 'Third'])
    assert.equal(output.output, 'Hello world!\nSecond line\nThird', `${protocol}: timed publication must not change final assistant evidence`)
    output.flush()
    const afterFlush = events.length
    mock.timers.tick(flushIntervalMs * 4)
    assert.equal(events.length, afterFlush, `${protocol}: no duplicate or late events after final flush`)

    // A timer publication is not a line boundary. The following newline closes
    // the published row without adding an extra blank line.
    events.length = 0
    append('One')
    mock.timers.tick(flushIntervalMs)
    append('\n\nTwo\n')
    assert.deepEqual(rows().map(row => row.text), ['One', '', 'Two'])
    const completeLines = events.length
    mock.timers.tick(flushIntervalMs)
    assert.equal(events.length, completeLines, `${protocol}: complete lines need no timed updates`)

    events.length = 0
    const assistantEvidence = output.output
    append('Reasoning without a newline', 'thinking')
    mock.timers.tick(flushIntervalMs)
    assert.deepEqual(rows().map(row => [row.category, row.text]), [['thinking', 'Reasoning without a newline']])
    assert.equal(output.output, assistantEvidence, `${protocol}: thinking is not assistant evidence`)
    output.flush()

    // Flush pending text before tool rows; later text must not overwrite it.
    events.length = 0
    append('Before the tool', 'message', 'tool-message')
    if (output instanceof AcpOutput) {
      output.update({ sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Read file', status: 'completed' })
    } else {
      output.item({ id: 'tool', type: 'commandExecution', command: 'pwd', status: 'completed' }, true)
    }
    append('After the tool', 'message', 'tool-message')
    mock.timers.tick(flushIntervalMs)
    assert.deepEqual(rows().map(row => row.category), ['message', 'tool_use', 'tool_result', 'message'])
    assert.notEqual(rows()[0].id, rows()[3].id)
    output.flush()

    // Completion before the timer fires flushes once and clears the timer.
    events.length = 0
    append('Final fragment', 'message', 'last')
    output.flush()
    assert.deepEqual(rows().map(row => row.text), ['Final fragment'])
    const completed = events.length
    mock.timers.tick(flushIntervalMs * 4)
    assert.equal(events.length, completed)
  } finally {
    output.flush()
    mock.timers.reset()
  }
}

// Completing one Codex stream must not postpone another stream's pending flush.
mock.timers.enable({ apis: ['setTimeout'] })
try {
  const events: TaskEvent[] = []
  const output = new CodexAppServerOutput(input, event => { events.push(event) })
  output.notification('item/reasoning/textDelta', { itemId: 'first', delta: 'First thought' })
  mock.timers.tick(100)
  output.notification('item/reasoning/textDelta', { itemId: 'second', delta: 'Second thought' })
  mock.timers.tick(100)
  output.item({ id: 'first', type: 'reasoning', content: ['First thought'] }, true)
  mock.timers.tick(50)
  assert.deepEqual(events.flatMap(event => event.type === 'output' ? [event.event.text] : []), ['First thought', 'Second thought'])
  output.flush()
} finally {
  mock.timers.reset()
}

// ACP message IDs delimit both messages and thinking, including consecutive
// thoughts that contain no tool call or newline between them.
mock.timers.enable({ apis: ['setTimeout'] })
try {
  const events: TaskEvent[] = []
  const output = new AcpOutput(input, event => { events.push(event) })
  for (const messageId of ['first', 'second']) {
    output.update({ sessionUpdate: 'agent_thought_chunk', messageId, content: { type: 'text', text: messageId } })
    mock.timers.tick(flushIntervalMs)
  }
  output.flush()
  assert.deepEqual(events.flatMap(event => event.type === 'output' ? [event.event.text] : []), ['first', 'second'])
} finally {
  mock.timers.reset()
}

// A final Codex snapshot reconciles against raw streamed text, even after one
// or more timed publications. Late deltas cannot alter the completed item.
mock.timers.enable({ apis: ['setTimeout'] })
try {
  const events: TaskEvent[] = []
  const output = new CodexAppServerOutput(input, event => { events.push(event) })
  output.notification('item/agentMessage/delta', { itemId: 'snapshot', delta: 'A draft' })
  mock.timers.tick(flushIntervalMs)
  output.item({ id: 'snapshot', type: 'agentMessage', text: 'A draft completed' }, true)
  output.notification('item/agentMessage/delta', { itemId: 'snapshot', delta: 'late' })
  const rows = [...new Map(events.flatMap(event => event.type === 'output' ? [[event.event.id, event.event] as const] : [])).values()]
  assert.deepEqual(rows.map(row => row.text), ['A draft completed'])
  assert.equal(output.output, 'A draft completed')
  const completed = events.length
  mock.timers.tick(flushIntervalMs * 4)
  assert.equal(events.length, completed)
  output.flush()
} finally {
  mock.timers.reset()
}

console.log('Agent streaming output tests passed: timed partial rows, stable IDs, line boundaries, thinking, tools, completion, and snapshots')
