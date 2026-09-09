import { testWorkspace } from './workspace-fixture'
import { onTestCleanup } from './test-cleanup'
import { expect, test, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/main/store'
import { EventEmitter } from 'node:events'
import { registerTaskEvents } from '../src/main/tasks/events'
import type { TaskContext } from '../src/main/tasks/context'
import type { TaskEvent as OutputEvent } from '../src/shared/types'
import { CodexAppServerOutput } from '../src/main/agents/codex-app-server-output'
import { AcpOutput } from '../src/main/agents/acp-output'
import type { TaskEvent, TaskInput } from '../src/main/agents/agent-executor'

test('reconciles tool and text snapshots and persists row identity', () => {
  const input: TaskInput = { workspace: testWorkspace(), taskId: 'output-test', issueId: 'first-issue', prompt: 'hello', cwd: '/tmp' }
  const events: TaskEvent[] = []
  const record = (event: TaskEvent): void => { events.push(event) }
  const rows = () => [...new Map(events.flatMap((event) => event.type === 'output' ? [[event.event.id, event.event] as const] : [])).values()]

  const codex = new CodexAppServerOutput(input, record)
  onTestCleanup(() => codex.flush())
  codex.item({ id: 'shell', type: 'commandExecution', command: 'pwd && ls', status: 'inProgress' }, false)
  codex.notification('item/commandExecution/outputDelta', { itemId: 'shell', delta: '/tmp\nfirst.ts\nsec' })
  codex.notification('item/commandExecution/outputDelta', { itemId: 'shell', delta: 'ond.ts\n' })
  codex.item({ id: 'shell', type: 'commandExecution', command: 'pwd && ls', status: 'completed', aggregatedOutput: '/tmp\nfirst.ts\nsecond.ts\n', exitCode: 0 }, true)
  expect(rows().filter((event) => event.category === 'tool_use').map((event) => event.text)).toStrictEqual(['Shell\npwd && ls'])
  expect(rows().filter((event) => event.category === 'tool_result').length, 'One result row per call, not per output line').toBe(1)
  expect(rows().find((event) => event.category === 'tool_result')?.text).toBe('/tmp\nfirst.ts\nsecond.ts\n')
  expect(codex.output, 'Tool output never becomes assistant output').toBe('')

  // ACP patches replace prior fields, including explicit nulls, and completed content is a snapshot.
  events.length = 0
  const acp = new AcpOutput(input, record)
  onTestCleanup(() => acp.flush())
  acp.update({ sessionUpdate: 'tool_call', toolCallId: 'shell', title: 'Run command', kind: 'execute', status: 'pending' })
  acp.update({ sessionUpdate: 'tool_call_update', toolCallId: 'shell', title: 'List files', rawInput: { command: 'pwd && ls' }, status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: '/tmp\nfirst.ts' } }] })
  acp.update({ sessionUpdate: 'tool_call_update', toolCallId: 'shell', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '/tmp\nfirst.ts\nsecond.ts\n' } }] })
  acp.update({ sessionUpdate: 'tool_call_update', toolCallId: 'shell', status: 'completed' })
  expect(rows().filter((event) => event.category === 'tool_use').map((event) => event.text)).toStrictEqual(['List files\npwd && ls'])
  expect(rows().filter((event) => event.category === 'tool_result').length).toBe(1)
  expect(rows().find((event) => event.category === 'tool_result')?.text).toBe('/tmp\nfirst.ts\nsecond.ts\n')
  expect(acp.output).toBe('')

  // Interleaved calls stay separate; authoritative snapshots replace rather than concatenate.
  events.length = 0
  input.issueId = 'second-issue'
  const parallel = new CodexAppServerOutput(input, record)
  onTestCleanup(() => parallel.flush())
  for (const id of ['first', 'second']) parallel.item({ id, type: 'commandExecution', command: id }, false)
  parallel.notification('item/commandExecution/outputDelta', { itemId: 'first', delta: 'draft\n' })
  parallel.notification('item/commandExecution/outputDelta', { itemId: 'second', delta: 'other\n' })
  parallel.item({ id: 'first', type: 'commandExecution', command: 'first', aggregatedOutput: 'final\n', status: 'completed', exitCode: 1 }, true)
  parallel.item({ id: 'second', type: 'commandExecution', command: 'second', status: 'completed' }, true)
  parallel.notification('item/commandExecution/outputDelta', { itemId: 'first', delta: 'late duplicate' })
  expect(rows().map((event) => [event.category, event.text]), 'Results stay beside their own call even when output is interleaved').toStrictEqual([
    ['tool_use', 'Shell\nfirst'], ['error', 'final\n'],
    ['tool_use', 'Shell\nsecond'], ['tool_result', 'other\n']
  ])
  const firstIds = rows().map((event) => event.id)
  new CodexAppServerOutput(input, record).item({ id: 'first', type: 'commandExecution', command: 'another execution' }, false)
  expect(!firstIds.includes(rows().at(-1)!.id), 'Protocol IDs are scoped to an execution').toBeTruthy()

  const mcp = new CodexAppServerOutput(input, record)
  onTestCleanup(() => mcp.flush())
  mcp.item({ id: 'mcp', type: 'mcpToolCall', server: 'docs', tool: 'search', arguments: { query: 'ACP' }, result: { query: 'ACP', matches: ['tool calls'] }, status: 'completed' }, true)
  expect(rows().at(-2)?.text).toBe('docs/search\nACP')
  expect(rows().at(-1)?.text, 'Results retain every field').toBe('{"query":"ACP","matches":["tool calls"]}')

  acp.update({ sessionUpdate: 'tool_call', toolCallId: 'named', name: 'bash', title: 'Run tests', kind: 'execute', rawInput: { command: 'npm test' }, status: 'in_progress' })
  acp.update({ sessionUpdate: 'tool_call_update', toolCallId: 'named', name: null, status: 'failed', rawOutput: { message: 'failed', details: 'assertion' } })
  expect(rows().at(-2)?.text).toBe('bash\nnpm test')
  expect(rows().at(-1)?.category).toBe('error')
  expect(rows().at(-1)?.text).toBe('{"message":"failed","details":"assertion"}')
  expect(rows().slice(-2).every(event => event.issueId === 'first-issue'), 'Late tool updates retain their producing turn despite input mutation').toBe(true)
  expect(rows().slice(0, 4).every(event => event.issueId === 'second-issue')).toBe(true)
  const rowCount = rows().length
  acp.update({ sessionUpdate: 'tool_call_update', toolCallId: 'named', status: 'failed', rawOutput: { message: 'failed', details: 'assertion' } })
  expect(rows().length).toBe(rowCount)

  // Partial text snapshots also persist in place rather than duplicating rows.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const message = new AcpOutput(input, record)
    onTestCleanup(() => message.flush())
    const thought = new CodexAppServerOutput(input, record)
    onTestCleanup(() => thought.flush())
    message.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial message' } })
    thought.notification('item/reasoning/textDelta', { itemId: 'thought', delta: 'Partial thinking' })
    vi.advanceTimersByTime(250)
    const partialIds = rows().slice(-2).map(row => row.id)
    message.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' completed\n' } })
    thought.item({ id: 'thought', type: 'reasoning', content: ['Partial thinking completed'] }, true)
    message.flush()
    expect(rows().slice(-2).map(row => row.id)).toStrictEqual(partialIds)
    expect(rows().slice(-2).map(row => row.text)).toStrictEqual(['Partial message completed\n', 'Partial thinking completed'])
    thought.flush()
  } finally {
    vi.useRealTimers()
  }

  // Both protocols persist snapshots in place, including success-to-error transitions.
  const directory = mkdtempSync(join(tmpdir(), 'anvil-output-'))
  const options = { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') }
  let store: Store | undefined
  try {
    const database = join(directory, 'test.db')
    store = new Store(database, options)
    store.addProject({ id: 'project', name: 'Test', path: directory, createdAt: 0, monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
    store.addTask({
      id: input.taskId, projectId: 'project', title: 'Output', prompt: input.prompt, cwd: directory,
      agentId: 'codex', agentLabel: 'Codex', status: 'succeeded', deliveryStatus: 'no_changes', startedAt: 0,
      inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null,
      filesChanged: 0, additions: 0, deletions: 0
    })
    const agentProcesses = new EventEmitter() as TaskContext['agentProcesses']
    const live: OutputEvent[] = []
    registerTaskEvents({ store, agentProcesses, send: (channel, event) => {
      if (channel === 'task:event') live.push(event as OutputEvent)
    } })
    for (const event of events) if (event.type === 'output') agentProcesses.emit('event', event.event)
    expect(live).toStrictEqual(events.flatMap(event => event.type === 'output' ? [event.event] : []))
    expect(store.readEvents(input.taskId)).toStrictEqual(rows())
    store.close()
    store = new Store(database, options)
    expect(store.readEvents(input.taskId), 'Restart preserves row order, IDs, and final content').toStrictEqual(rows())
    store.saveTaskExecution({ taskId: input.taskId, projectPath: directory, parentIssueId: 'parent', phase: 'working', issueIds: ['second-issue'], currentIssueId: 'second-issue', error: null })
    // Register against the reopened store. Task delivery never inherits the active issue.
    const reopened = registerTaskEvents({ store, agentProcesses: new EventEmitter() as TaskContext['agentProcesses'], send: () => {} })
    reopened.recordSystemEvent(input.taskId, 'Final task diff')
    expect(store.readEvents(input.taskId).at(-1)).toMatchObject({ kind: 'delivery', issueId: undefined })
  } finally {
    store?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
