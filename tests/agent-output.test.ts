import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/main/store'
import { CodexAppServerOutput } from '../src/main/agents/codex-app-server-output'
import { AcpOutput } from '../src/main/agents/acp-output'
import type { TaskEvent, TaskInput } from '../src/main/agents/agent-executor'

const input: TaskInput = { taskId: 'output-test', prompt: 'hello', cwd: '/tmp' }
const events: TaskEvent[] = []
const record = (event: TaskEvent): void => { events.push(event) }
const rows = () => [...new Map(events.flatMap((event) => event.type === 'output' ? [[event.event.id, event.event] as const] : [])).values()]

const codex = new CodexAppServerOutput(input, record)
codex.item({ id: 'shell', type: 'commandExecution', command: 'pwd && ls', status: 'inProgress' }, false)
codex.notification('item/commandExecution/outputDelta', { itemId: 'shell', delta: '/tmp\nfirst.ts\nsec' })
codex.notification('item/commandExecution/outputDelta', { itemId: 'shell', delta: 'ond.ts\n' })
codex.item({ id: 'shell', type: 'commandExecution', command: 'pwd && ls', status: 'completed', aggregatedOutput: '/tmp\nfirst.ts\nsecond.ts\n', exitCode: 0 }, true)
assert.deepEqual(rows().filter((event) => event.category === 'tool_use').map((event) => event.text), ['Shell\npwd && ls'])
assert.equal(rows().filter((event) => event.category === 'tool_result').length, 1, 'One result row per call, not per output line')
assert.equal(rows().find((event) => event.category === 'tool_result')?.text, '/tmp\nfirst.ts\nsecond.ts\n')
assert.equal(codex.output, '', 'Tool output never becomes assistant output')

// ACP patches replace prior fields, including explicit nulls, and completed content is a snapshot.
events.length = 0
const acp = new AcpOutput(input, record)
acp.update({ sessionUpdate: 'tool_call', toolCallId: 'shell', title: 'Run command', kind: 'execute', status: 'pending' })
acp.update({ sessionUpdate: 'tool_call_update', toolCallId: 'shell', title: 'List files', rawInput: { command: 'pwd && ls' }, status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: '/tmp\nfirst.ts' } }] })
acp.update({ sessionUpdate: 'tool_call_update', toolCallId: 'shell', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: '/tmp\nfirst.ts\nsecond.ts\n' } }] })
acp.update({ sessionUpdate: 'tool_call_update', toolCallId: 'shell', status: 'completed' })
assert.deepEqual(rows().filter((event) => event.category === 'tool_use').map((event) => event.text), ['List files\npwd && ls'])
assert.equal(rows().filter((event) => event.category === 'tool_result').length, 1)
assert.equal(rows().find((event) => event.category === 'tool_result')?.text, '/tmp\nfirst.ts\nsecond.ts\n')
assert.equal(acp.output, '')

// Interleaved calls stay separate; authoritative snapshots replace rather than concatenate.
events.length = 0
const parallel = new CodexAppServerOutput(input, record)
for (const id of ['first', 'second']) parallel.item({ id, type: 'commandExecution', command: id }, false)
parallel.notification('item/commandExecution/outputDelta', { itemId: 'first', delta: 'draft\n' })
parallel.notification('item/commandExecution/outputDelta', { itemId: 'second', delta: 'other\n' })
parallel.item({ id: 'first', type: 'commandExecution', command: 'first', aggregatedOutput: 'final\n', status: 'completed', exitCode: 1 }, true)
parallel.item({ id: 'second', type: 'commandExecution', command: 'second', status: 'completed' }, true)
parallel.notification('item/commandExecution/outputDelta', { itemId: 'first', delta: 'late duplicate' })
assert.deepEqual(rows().map((event) => [event.category, event.text]), [
  ['tool_use', 'Shell\nfirst'], ['error', 'final\n'],
  ['tool_use', 'Shell\nsecond'], ['tool_result', 'other\n']
], 'Results stay beside their own call even when output is interleaved')
const firstIds = rows().map((event) => event.id)
new CodexAppServerOutput(input, record).item({ id: 'first', type: 'commandExecution', command: 'another execution' }, false)
assert.ok(!firstIds.includes(rows().at(-1)!.id), 'Protocol IDs are scoped to an execution')

const mcp = new CodexAppServerOutput(input, record)
mcp.item({ id: 'mcp', type: 'mcpToolCall', server: 'docs', tool: 'search', arguments: { query: 'ACP' }, result: { query: 'ACP', matches: ['tool calls'] }, status: 'completed' }, true)
assert.equal(rows().at(-2)?.text, 'docs/search\nACP')
assert.equal(rows().at(-1)?.text, '{"query":"ACP","matches":["tool calls"]}', 'Results retain every field')

acp.update({ sessionUpdate: 'tool_call', toolCallId: 'named', name: 'bash', title: 'Run tests', kind: 'execute', rawInput: { command: 'npm test' }, status: 'in_progress' })
acp.update({ sessionUpdate: 'tool_call_update', toolCallId: 'named', name: null, status: 'failed', rawOutput: { message: 'failed', details: 'assertion' } })
assert.equal(rows().at(-2)?.text, 'bash\nnpm test')
assert.equal(rows().at(-1)?.category, 'error')
assert.equal(rows().at(-1)?.text, '{"message":"failed","details":"assertion"}')
const rowCount = rows().length
acp.update({ sessionUpdate: 'tool_call_update', toolCallId: 'named', status: 'failed', rawOutput: { message: 'failed', details: 'assertion' } })
assert.equal(rows().length, rowCount)

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
  for (const event of events) if (event.type === 'output') store.appendEvent(event.event)
  assert.deepEqual(store.readEvents(input.taskId), rows())
  store.close()
  store = new Store(database, options)
  assert.deepEqual(store.readEvents(input.taskId), rows(), 'Restart preserves row order, IDs, and final content')
} finally {
  store?.close()
  rmSync(directory, { recursive: true, force: true })
}
console.log('Agent output tests passed: tool snapshots, patches, concurrency, failures, and persistence')
