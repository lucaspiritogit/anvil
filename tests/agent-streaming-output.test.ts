import { testWorkspace } from './workspace-fixture'
import { onTestCleanup } from './test-cleanup'
import { expect, test, vi } from 'vitest'
import { AcpOutput } from '../src/server/agents/acp-output'
import { CodexAppServerOutput } from '../src/server/agents/codex-app-server-output'
import type { TaskEvent, TaskInput } from '../src/server/agents/agent-executor'

const input: TaskInput = { workspace: testWorkspace(), taskId: 'streaming-output', prompt: 'hello', cwd: '/tmp' }
const flushIntervalMs = 250

test.each(['acp', 'codex'] as const)('%s preserves paragraph breaks within reasoning', (protocol) => {
  const events: TaskEvent[] = []
  const record = (event: TaskEvent): void => { events.push(event) }
  const output = protocol === 'acp' ? new AcpOutput(input, record) : new CodexAppServerOutput(input, record)
  onTestCleanup(() => output.flush())
  const text = 'First paragraph.\n\nSecond paragraph.'
  if (output instanceof AcpOutput) {
    output.update({ sessionUpdate: 'agent_thought_chunk', messageId: 'reasoning', content: { type: 'text', text } })
  } else {
    output.notification('item/reasoning/textDelta', { itemId: 'reasoning', delta: text })
  }
  output.flush()
  const rows = [...new Map(events.flatMap(event => event.type === 'output' ? [[event.event.id, event.event] as const] : [])).values()]
  expect(rows.map(row => row.text), `${protocol}: preserve paragraph breaks within one reasoning event, not empty thinking rows`).toStrictEqual([text])
})

test.each(['acp', 'codex'] as const)('%s batches at the exact deadline and preserves IDs, timestamps and ordering', (protocol) => {
  const events: TaskEvent[] = []
  const record = (event: TaskEvent): void => { events.push(event) }
  const output = protocol === 'acp' ? new AcpOutput(input, record) : new CodexAppServerOutput(input, record)
  onTestCleanup(() => output.flush())
  const rows = () => [...new Map(events.flatMap(event => event.type === 'output' ? [[event.event.id, event.event] as const] : [])).values()]
  const append = (text: string, category: 'message' | 'thinking' = 'message', messageId = 'first'): void => {
    if (output instanceof AcpOutput) {
      output.update({ sessionUpdate: category === 'message' ? 'agent_message_chunk' : 'agent_thought_chunk', messageId, content: { type: 'text', text } })
    } else {
      output.notification(category === 'message' ? 'item/agentMessage/delta' : 'item/reasoning/textDelta', { itemId: messageId, delta: text })
    }
  }

  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: 1_000 })
  try {
    append('Hel')
    vi.advanceTimersByTime(100)
    append('lo')
    vi.advanceTimersByTime(149)
    expect(rows().length, `${protocol}: coalesce small deltas before publishing`).toBe(0)
    vi.advanceTimersByTime(1)
    expect(rows().map(row => row.text), `${protocol}: show partial text within 250 ms without a newline`).toStrictEqual(['Hello'])
    const partial = rows()[0]

    append(' world')
    vi.advanceTimersByTime(flushIntervalMs)
    expect(rows().length, `${protocol}: update the partial row, do not append a fragment`).toBe(1)
    expect(rows()[0].id).toBe(partial.id)
    expect(rows()[0].ts).toBe(partial.ts)
    expect(rows()[0].text).toBe('Hello world')

    append('!\nSecond line\nThird')
    expect(rows().map(row => row.text), `${protocol}: newlines do not publish or split a protocol event`).toStrictEqual(['Hello world'])
    vi.advanceTimersByTime(flushIntervalMs)
    expect(rows().map(row => row.text)).toStrictEqual(['Hello world!\nSecond line\nThird'])
    expect(rows()[0].id, `${protocol}: line breaks preserve the streaming event ID`).toBe(partial.id)
    expect(output.output, `${protocol}: timed publication must not change final assistant evidence`).toBe('Hello world!\nSecond line\nThird')
    output.flush()
    const afterFlush = events.length
    vi.advanceTimersByTime(flushIntervalMs * 4)
    expect(events.length, `${protocol}: no duplicate or late events after final flush`).toBe(afterFlush)

    // Paragraph separators stay within a single evolving event, even when
    // they arrive in a later delta than the text before them.
    events.length = 0
    append('One')
    vi.advanceTimersByTime(flushIntervalMs)
    const paragraphId = rows()[0].id
    append('\n\nTwo\n')
    vi.advanceTimersByTime(flushIntervalMs)
    expect(rows().map(row => row.text)).toStrictEqual(['One\n\nTwo\n'])
    expect(rows()[0].id).toBe(paragraphId)
    output.flush()
    const completedParagraphs = events.length
    vi.advanceTimersByTime(flushIntervalMs)
    expect(events.length, `${protocol}: completion clears the timer`).toBe(completedParagraphs)

    events.length = 0
    const assistantEvidence = output.output
    append('Reasoning without a newline', 'thinking')
    vi.advanceTimersByTime(flushIntervalMs)
    expect(rows().map(row => [row.category, row.text])).toStrictEqual([['thinking', 'Reasoning without a newline']])
    expect(output.output, `${protocol}: thinking is not assistant evidence`).toBe(assistantEvidence)
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
    vi.advanceTimersByTime(flushIntervalMs)
    expect(rows().map(row => row.category)).toStrictEqual(['message', 'tool_use', 'tool_result', 'message'])
    expect(rows()[0].id).not.toBe(rows()[3].id)
    output.flush()

    // Completion before the timer fires flushes once and clears the timer.
    events.length = 0
    append('Final fragment', 'message', 'last')
    output.flush()
    expect(rows().map(row => row.text)).toStrictEqual(['Final fragment'])
    const completed = events.length
    vi.advanceTimersByTime(flushIntervalMs * 4)
    expect(events.length).toBe(completed)
  } finally {
    output.flush()
    vi.useRealTimers()
  }
})

test.each(['acp', 'codex'] as const)('%s preserves whitespace and strips ANSI fragments', (protocol) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const events: TaskEvent[] = []
  const record = (event: TaskEvent): void => { events.push(event) }
  const output = protocol === 'acp' ? new AcpOutput(input, record) : new CodexAppServerOutput(input, record)
  onTestCleanup(() => output.flush())
  const append = (text: string): void => {
    if (output instanceof AcpOutput) output.update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } })
    else output.notification('item/reasoning/summaryTextDelta', { itemId: 'whitespace', summaryIndex: 0, delta: text })
  }
  try {
    append('\u001b[36m\n \n')
    vi.advanceTimersByTime(flushIntervalMs)
    expect(events.length, `${protocol}: defer whitespace-only or ANSI-only fragments`).toBe(0)
    append('  First paragraph.\r\n\r\n')
    vi.advanceTimersByTime(flushIntervalMs)
    append('Second paragraph.\u001b[0m')
    output.flush()
    const rows = [...new Map(events.flatMap(event => event.type === 'output' ? [[event.event.id, event.event] as const] : [])).values()]
    expect(rows.map(row => row.text)).toStrictEqual(['\n \n  First paragraph.\n\nSecond paragraph.'])
    expect(events.every(event => event.type !== 'output' || event.event.text.trim().length > 0)).toBeTruthy()
    events.length = 0
    append('\n\t\n')
    output.flush()
    vi.advanceTimersByTime(flushIntervalMs)
    expect(events.length, `${protocol}: no row for an entirely empty completed stream`).toBe(0)
  } finally {
    output.flush()
    vi.useRealTimers()
  }
})

test('delimits ACP text at category transitions', () => {
  const events: TaskEvent[] = []
  const output = new AcpOutput(input, event => { events.push(event) })
  onTestCleanup(() => output.flush())
  for (const [sessionUpdate, text] of [
    ['agent_thought_chunk', 'First thought.\n\nStill thinking.'],
    ['agent_message_chunk', 'First response.'],
    ['agent_thought_chunk', 'Second thought.'],
    ['agent_message_chunk', 'Second response.']
  ] as const) output.update({ sessionUpdate, content: { type: 'text', text } })
  output.flush()
  expect(events.flatMap(event => event.type === 'output' ? [[event.event.category, event.event.text]] : [])).toStrictEqual([
    ['thinking', 'First thought.\n\nStill thinking.'], ['message', 'First response.'],
    ['thinking', 'Second thought.'], ['message', 'Second response.']
  ])
})

test('reconciles indexed Codex reasoning sections', () => {
  const events: TaskEvent[] = []
  const output = new CodexAppServerOutput(input, event => { events.push(event) })
  onTestCleanup(() => output.flush())
  output.notification('item/reasoning/summaryTextDelta', { itemId: 'thought', summaryIndex: 0, delta: 'Summary one.\n\n' })
  output.notification('item/reasoning/summaryTextDelta', { itemId: 'thought', summaryIndex: 1, delta: 'Summary two.' })
  output.notification('item/reasoning/textDelta', { itemId: 'thought', contentIndex: 0, delta: 'Content.\n\n' })
  output.item({ id: 'thought', type: 'reasoning', summary: ['Summary one.\n\nComplete.', 'Summary two.'], content: ['Content.\n\nComplete.'] }, true)
  output.notification('item/reasoning/summaryTextDelta', { itemId: 'thought', summaryIndex: 0, delta: 'late' })
  output.flush()
  const rows = [...new Map(events.flatMap(event => event.type === 'output' ? [[event.event.id, event.event] as const] : [])).values()]
  expect(rows.map(row => row.text)).toStrictEqual(['Summary one.\n\nComplete.', 'Summary two.', 'Content.\n\nComplete.'])
})

test('flushes concurrent Codex streams without delaying peers', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const events: TaskEvent[] = []
    const output = new CodexAppServerOutput(input, event => { events.push(event) })
    onTestCleanup(() => output.flush())
    output.notification('item/reasoning/textDelta', { itemId: 'first', delta: 'First thought' })
    vi.advanceTimersByTime(100)
    output.notification('item/reasoning/textDelta', { itemId: 'second', delta: 'Second thought' })
    vi.advanceTimersByTime(100)
    output.item({ id: 'first', type: 'reasoning', content: ['First thought'] }, true)
    vi.advanceTimersByTime(50)
    expect(events.flatMap(event => event.type === 'output' ? [event.event.text] : [])).toStrictEqual(['First thought', 'Second thought'])
    output.flush()
  } finally {
    vi.useRealTimers()
  }
})

test('delimits consecutive ACP message IDs', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const events: TaskEvent[] = []
    const output = new AcpOutput(input, event => { events.push(event) })
    onTestCleanup(() => output.flush())
    for (const messageId of ['first', 'second']) {
      output.update({ sessionUpdate: 'agent_thought_chunk', messageId, content: { type: 'text', text: messageId } })
      vi.advanceTimersByTime(flushIntervalMs)
    }
    output.flush()
    expect(events.flatMap(event => event.type === 'output' ? [event.event.text] : [])).toStrictEqual(['first', 'second'])
  } finally {
    vi.useRealTimers()
  }
})

test('reconciles final Codex snapshots and ignores late deltas', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const events: TaskEvent[] = []
    const output = new CodexAppServerOutput(input, event => { events.push(event) })
    onTestCleanup(() => output.flush())
    output.notification('item/agentMessage/delta', { itemId: 'snapshot', delta: 'A draft' })
    vi.advanceTimersByTime(flushIntervalMs)
    output.item({ id: 'snapshot', type: 'agentMessage', text: 'A draft completed' }, true)
    output.notification('item/agentMessage/delta', { itemId: 'snapshot', delta: 'late' })
    const rows = [...new Map(events.flatMap(event => event.type === 'output' ? [[event.event.id, event.event] as const] : [])).values()]
    expect(rows.map(row => row.text)).toStrictEqual(['A draft completed'])
    expect(output.output).toBe('A draft completed')
    const completed = events.length
    vi.advanceTimersByTime(flushIntervalMs * 4)
    expect(events.length).toBe(completed)
    output.flush()
  } finally {
    vi.useRealTimers()
  }
})
