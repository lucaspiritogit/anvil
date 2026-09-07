import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { AcpOutput } from '../src/main/agents/acp-output'
import { CodexAppServerOutput } from '../src/main/agents/codex-app-server-output'
import type { TaskEvent, TaskInput } from '../src/main/agents/agent-executor'

const input: TaskInput = { taskId: 'streaming-output', prompt: 'hello', cwd: '/tmp' }
const flushIntervalMs = 250

// The reported ACP session contains one reasoning part with paragraph breaks.
// Newlines are text inside that part, not separate output events.
for (const protocol of ['acp', 'codex'] as const) {
  const events: TaskEvent[] = []
  const record = (event: TaskEvent): void => { events.push(event) }
  const output = protocol === 'acp' ? new AcpOutput(input, record) : new CodexAppServerOutput(input, record)
  const text = 'First paragraph.\n\nSecond paragraph.'
  if (output instanceof AcpOutput) {
    output.update({ sessionUpdate: 'agent_thought_chunk', messageId: 'reasoning', content: { type: 'text', text } })
  } else {
    output.notification('item/reasoning/textDelta', { itemId: 'reasoning', delta: text })
  }
  output.flush()
  const rows = [...new Map(events.flatMap(event => event.type === 'output' ? [[event.event.id, event.event] as const] : [])).values()]
  assert.deepEqual(rows.map(row => row.text), [text], `${protocol}: preserve paragraph breaks within one reasoning event, not empty thinking rows`)
}

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
    assert.deepEqual(rows().map(row => row.text), ['Hello world'], `${protocol}: newlines do not publish or split a protocol event`)
    mock.timers.tick(flushIntervalMs)
    assert.deepEqual(rows().map(row => row.text), ['Hello world!\nSecond line\nThird'])
    assert.equal(rows()[0].id, partial.id, `${protocol}: line breaks preserve the streaming event ID`)
    assert.equal(output.output, 'Hello world!\nSecond line\nThird', `${protocol}: timed publication must not change final assistant evidence`)
    output.flush()
    const afterFlush = events.length
    mock.timers.tick(flushIntervalMs * 4)
    assert.equal(events.length, afterFlush, `${protocol}: no duplicate or late events after final flush`)

    // Paragraph separators stay within a single evolving event, even when
    // they arrive in a later delta than the text before them.
    events.length = 0
    append('One')
    mock.timers.tick(flushIntervalMs)
    const paragraphId = rows()[0].id
    append('\n\nTwo\n')
    mock.timers.tick(flushIntervalMs)
    assert.deepEqual(rows().map(row => row.text), ['One\n\nTwo\n'])
    assert.equal(rows()[0].id, paragraphId)
    output.flush()
    const completedParagraphs = events.length
    mock.timers.tick(flushIntervalMs)
    assert.equal(events.length, completedParagraphs, `${protocol}: completion clears the timer`)

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

// Formatting-only deltas are not events, but their whitespace must survive
// when real content arrives. This also covers ANSI-only provider fragments.
for (const protocol of ['acp', 'codex'] as const) {
  mock.timers.enable({ apis: ['setTimeout'] })
  const events: TaskEvent[] = []
  const record = (event: TaskEvent): void => { events.push(event) }
  const output = protocol === 'acp' ? new AcpOutput(input, record) : new CodexAppServerOutput(input, record)
  const append = (text: string): void => {
    if (output instanceof AcpOutput) output.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } })
    else output.notification('item/reasoning/summaryTextDelta', { itemId: 'whitespace', summaryIndex: 0, delta: text })
  }
  try {
    append('\u001b[36m\n \n')
    mock.timers.tick(flushIntervalMs)
    assert.equal(events.length, 0, `${protocol}: defer whitespace-only or ANSI-only fragments`)
    append('  First paragraph.\r\n\r\n')
    mock.timers.tick(flushIntervalMs)
    append('Second paragraph.\u001b[0m')
    output.flush()
    const rows = [...new Map(events.flatMap(event => event.type === 'output' ? [[event.event.id, event.event] as const] : [])).values()]
    assert.deepEqual(rows.map(row => row.text), ['\n \n  First paragraph.\n\nSecond paragraph.'])
    assert.ok(events.every(event => event.type !== 'output' || event.event.text.trim().length > 0))
    events.length = 0
    append('\n\t\n')
    output.flush()
    mock.timers.tick(flushIntervalMs)
    assert.equal(events.length, 0, `${protocol}: no row for an entirely empty completed stream`)
  } finally {
    output.flush()
    mock.timers.reset()
  }
}

// ACP providers without message IDs still delimit text at category transitions.
{
  const events: TaskEvent[] = []
  const output = new AcpOutput(input, event => { events.push(event) })
  for (const [sessionUpdate, text] of [
    ['agent_thought_chunk', 'First thought.\n\nStill thinking.'],
    ['agent_message_chunk', 'First response.'],
    ['agent_thought_chunk', 'Second thought.'],
    ['agent_message_chunk', 'Second response.']
  ] as const) output.update({ sessionUpdate, content: { type: 'text', text } })
  output.flush()
  assert.deepEqual(events.flatMap(event => event.type === 'output' ? [[event.event.category, event.event.text]] : []), [
    ['thinking', 'First thought.\n\nStill thinking.'], ['message', 'First response.'],
    ['thinking', 'Second thought.'], ['message', 'Second response.']
  ])
}

// Codex indexes identify independent reasoning sections, not individual lines.
{
  const events: TaskEvent[] = []
  const output = new CodexAppServerOutput(input, event => { events.push(event) })
  output.notification('item/reasoning/summaryTextDelta', { itemId: 'thought', summaryIndex: 0, delta: 'Summary one.\n\n' })
  output.notification('item/reasoning/summaryTextDelta', { itemId: 'thought', summaryIndex: 1, delta: 'Summary two.' })
  output.notification('item/reasoning/textDelta', { itemId: 'thought', contentIndex: 0, delta: 'Content.\n\n' })
  output.item({ id: 'thought', type: 'reasoning', summary: ['Summary one.\n\nComplete.', 'Summary two.'], content: ['Content.\n\nComplete.'] }, true)
  output.notification('item/reasoning/summaryTextDelta', { itemId: 'thought', summaryIndex: 0, delta: 'late' })
  output.flush()
  const rows = [...new Map(events.flatMap(event => event.type === 'output' ? [[event.event.id, event.event] as const] : [])).values()]
  assert.deepEqual(rows.map(row => row.text), ['Summary one.\n\nComplete.', 'Summary two.', 'Content.\n\nComplete.'])
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

console.log('Agent streaming output tests passed: timed protocol events, stable IDs, paragraphs, thinking, tools, completion, and snapshots')
