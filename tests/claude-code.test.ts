import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, test } from 'vitest'
import { ClaudeCodeClient } from '../apps/server/src/agents/claude-code'
import { ClaudeCodeOutput } from '../apps/server/src/agents/claude-code-output'
import { CONTEXT_COMPACTED } from '@anvil/protocol/task-context'
import type { TaskEvent, TaskInput } from '../apps/server/src/agents/agent-executor'
import { testWorkspace } from './workspace-fixture'
import { onTestCleanup } from './test-cleanup'

interface Transcript {
  pid: number
  childPid?: number
  event?: string
  cwd?: string
  config?: string
  args?: string[]
  message?: Record<string, unknown>
}

async function fixture(scenario = 'success', workspaceId = 'default') {
  const directory = await mkdtemp(join(tmpdir(), 'anvil-claude-code-'))
  onTestCleanup(() => rm(directory, { recursive: true, force: true }))
  const transcript = join(directory, 'transcript.jsonl')
  const workspace = testWorkspace(workspaceId)
  const client = new ClaudeCodeClient({ workspace, command: process.execPath,
    args: [resolve('tests/fixtures/claude-code.cjs'), scenario, transcript], requestTimeoutMs: 1000 })
  onTestCleanup(() => client.close())
  const input: TaskInput = { taskId: 'task', workspace, cwd: directory, prompt: 'Implement the task', model: 'fable', reasoningEffort: 'max' }
  const entries = async (): Promise<Transcript[]> => (await readFile(transcript, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  return { directory, transcript, workspace, client, input, entries }
}

function userMessages(entries: Transcript[]): Record<string, unknown>[] {
  return entries.flatMap((entry) => entry.message?.type === 'user' ? [entry.message] : [])
}

test('runs native Claude streams with images, tools, subscription usage and current context', async () => {
  const f = await fixture()
  const events: TaskEvent[] = []
  let accepted = 0
  let checked = false
  const result = await f.client.execute({ ...f.input, prompt: 'Implement /literal @path',
    images: [{ filename: 'image.png', mimeType: 'image/png', bytes: new Uint8Array([1, 2, 3]) }],
    beforeDispatch: () => { checked = true }, onStarted: () => { accepted++; expect(checked).toBe(true) },
    mcpServers: [{ name: 'anvil_issue_tracker', url: 'http://127.0.0.1:1234/mcp', headers: { Authorization: 'task-token' }, required: true }]
  }, (event) => { events.push(event) })
  expect(result.status, result.error).toBe('succeeded')
  expect(result.output).toBe('Hello Claude\nSecond block')
  expect(result.changedFiles).toEqual(['file.ts'])
  expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20, cachedTokens: 70, totalTokens: 100, costUsd: null })
  expect(accepted).toBe(1)
  const messages = events.filter((event) => event.type === 'output' && event.event.category === 'message')
  expect(messages.map((event) => event.type === 'output' ? event.event.text : '')).toEqual(['Hello Claude', 'Second block'])
  expect(events.some((event) => event.type === 'context' && event.contextUsed === 124 && event.contextSize === 200000)).toBe(true)
  const entries = await f.entries()
  const user = userMessages(entries)[0]
  expect(user).toMatchObject({ origin: { kind: 'human' }, message: {
    content: [{ type: 'text', text: 'Implement /literal @path' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AQID' } }]
  } })
  expect(user.client_composed).toBeUndefined()
  expect(entries[0].args).toEqual(expect.arrayContaining(['--effort', 'max', '--strict-mcp-config']))
  const subtype = entries.map((entry) => (entry.message?.request as Record<string, unknown> | undefined)?.subtype)
  expect(subtype.indexOf('mcp_status')).toBeLessThan(entries.findIndex((entry) => entry.message?.type === 'user'))
  expect(entries[0].cwd).toBe(await realpath(f.directory))
})

test('subtracts resumed session usage rather than charging old model requests again', async () => {
  const f = await fixture()
  const events: TaskEvent[] = []
  const result = await f.client.execute({ ...f.input, resumeSessionId: 'saved-session' }, (event) => { events.push(event) })
  expect(result).toMatchObject({ status: 'succeeded', sessionId: 'saved-session',
    usage: { inputTokens: 10, outputTokens: 20, cachedTokens: 70, totalTokens: 100, costUsd: null } })
  expect(events.filter((event) => event.type === 'usage')).toHaveLength(1)
  expect((await f.entries())[0].args).toEqual(expect.arrayContaining(['--resume', 'saved-session']))
})

test('slash-leading ordinary prompts remain user requests while Claude loads native project context', async () => {
  const f = await fixture()
  const result = await f.client.execute({ ...f.input, prompt: '  /compact this is an ordinary user request' }, () => {})
  expect(result.status, result.error).toBe('succeeded')
  const message = userMessages(await f.entries())[0]
  expect(message.client_composed).toBeUndefined()
  expect(message).toMatchObject({ message: { content: [{ type: 'text', text: 'User request:\n\n  /compact this is an ordinary user request' }] } })
})

test('discovers native model capabilities without dispatching a prompt and closes the probe', async () => {
  const f = await fixture()
  const models = await f.client.listModels()
  expect(models.models).toEqual(['fable', 'haiku'])
  expect(models.displayByModel).toEqual({
    fable: { name: 'Claude Fable 5', resolvedModel: 'claude-fable-5' },
    haiku: { name: 'Haiku', resolvedModel: 'claude-haiku-4-5' }
  })
  expect(models.reasoningByModel?.fable.options.map((option) => option.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  expect(models.reasoningByModel?.haiku.options).toEqual([])
  const entries = await f.entries()
  expect(userMessages(entries)).toEqual([])
  expect(entries[0].args).toContain('--no-session-persistence')
  expect(entries[0].args).toContain('--safe-mode')
  expect(() => process.kill(entries[0].pid, 0)).toThrow()
})

test('required MCP, changed task state and API credentials stop execution before a model prompt', async () => {
  for (const scenario of ['mcp-failed', 'api-auth', 'api-provider', 'oauth-env', 'api-key-auth', 'stale']) {
    const f = await fixture(scenario)
    let accepted = false
    const result = await f.client.execute({ ...f.input, onStarted: () => { accepted = true },
      beforeDispatch: scenario === 'stale' ? () => { throw new Error('Task stopped') } : undefined,
      mcpServers: [{ name: 'anvil_issue_tracker', url: 'http://127.0.0.1:1234/mcp', headers: {}, required: true }]
    }, () => {})
    expect(result.status).toBe('failed')
    expect(result.retry).toBeUndefined()
    expect(accepted).toBe(false)
    expect(userMessages(await f.entries())).toEqual([])
  }
})

test('missing saved sessions recover only from explicitly supplied task recovery context', async () => {
  for (const scenario of ['missing', 'missing-stderr']) {
    const f = await fixture(scenario)
    const result = await f.client.execute({ ...f.input, resumeSessionId: 'missing-session', resumeFallbackPrompt: 'Recover the saved task plan' }, () => {})
    expect(result.status, result.error).toBe('succeeded')
    expect(result.sessionId).not.toBe('missing-session')
    const entries = await f.entries()
    expect(entries.filter((entry) => entry.event === 'spawn')).toHaveLength(2)
    expect(userMessages(entries)[0]).toMatchObject({ message: { content: [{ type: 'text', text: 'Recover the saved task plan' }] } })
    const withoutRecovery = await fixture(scenario)
    const failed = await withoutRecovery.client.execute({ ...withoutRecovery.input, resumeSessionId: 'missing-session' }, () => {})
    expect(failed.status).toBe('failed')
    expect(failed.error).toContain('No conversation found with session ID: missing-session')
    expect(failed.retry).toBeUndefined()
    expect(userMessages(await withoutRecovery.entries())).toEqual([])
  }
})

test('accepts native subscription metadata when initialization omits its optional token source and plan', async () => {
  const f = await fixture('subscription-metadata')
  const result = await f.client.execute(f.input, () => {})
  expect(result.status, result.error).toBe('succeeded')
  expect((await f.client.listModels()).models).toEqual(['fable', 'haiku'])
})

test('loads models and runs tasks when the native account reports its subscription display name', async () => {
  const f = await fixture('subscription-display-name')
  expect((await f.client.listModels()).models).toEqual(['fable', 'haiku'])
  expect(userMessages(await f.entries())).toEqual([])
  const result = await f.client.execute(f.input, () => {})
  expect(result.status, result.error).toBe('succeeded')
})

test('read-only metadata turns disable project hooks, persistence and mutating tools', async () => {
  const f = await fixture()
  const events: TaskEvent[] = []
  const result = await f.client.execute({ ...f.input, readOnly: true,
    mcpServers: [{ name: 'anvil_issue_tracker', url: 'http://127.0.0.1:1234/mcp', headers: {}, required: true }]
  }, (event) => { events.push(event) })
  expect(result.status, result.error).toBe('succeeded')
  const args = (await f.entries())[0].args!
  expect(args).toEqual(expect.arrayContaining(['--safe-mode', '--no-session-persistence', '--tools', 'Read,Glob,Grep']))
  expect(args).not.toContain('--dangerously-skip-permissions')
  expect(JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers).toEqual({})
  expect(events.filter((event) => event.type === 'session')).toEqual([])
})

test('subscription exhaustion remains stopped while transient provider failures may retry after cleanup', async () => {
  for (const scenario of ['quota', 'transient']) {
    const f = await fixture(scenario)
    const result = await f.client.execute(f.input, () => {})
    expect(result.status).toBe('failed')
    expect(result.retry).toEqual(scenario === 'quota' ? undefined : { source: 'provider' })
    const entries = await f.entries()
    expect(() => process.kill(entries[0].pid, 0)).toThrow()
  }
})

test('compacts through the native command without dispatching the original task prompt', async () => {
  const f = await fixture()
  const events: TaskEvent[] = []
  const result = await f.client.compact({ ...f.input, resumeSessionId: 'saved-session' }, (event) => { events.push(event) })
  expect(result.status, result.error).toBe('succeeded')
  expect(result.output).toBe('')
  const compact = userMessages(await f.entries())[0]
  expect(compact).toMatchObject({ message: { content: '/compact' } })
  expect(compact.client_composed).toBeUndefined()
  expect(events.filter((event) => event.type === 'output' && event.event.text === CONTEXT_COMPACTED)).toHaveLength(1)
  expect(events.some((event) => event.type === 'context' && event.contextUsed === 124 && event.contextSize === 200000)).toBe(true)
})

test('reports native compaction failure even when its local command result is successful', async () => {
  const f = await fixture('compact-failed')
  const result = await f.client.compact({ ...f.input, resumeSessionId: 'saved-session' }, () => {})
  expect(result.status).toBe('failed')
  expect(result.error).toContain('Cannot compact this conversation')
  expect(result.retry).toBeUndefined()
})

test('concurrent Claude tasks use separate processes and cancellation stops child tools without stopping a peer', async () => {
  const f = await fixture('mixed')
  const controller = new AbortController()
  const [cancelled, completed] = await Promise.all([
    f.client.execute({ ...f.input, prompt: 'Hang', signal: controller.signal }, (event) => {
      if (event.type === 'output' && event.event.text === 'Waiting') controller.abort()
    }),
    f.client.execute({ ...f.input, taskId: 'peer' }, () => {})
  ])
  expect(cancelled.status).toBe('cancelled')
  expect(completed.status).toBe('succeeded')
  const entries = await f.entries()
  const parents = entries.filter((entry) => entry.event === 'spawn')
  expect(parents).toHaveLength(2)
  expect(entries.some((entry) => entry.childPid)).toBe(true)
  for (const pid of [...parents.map((entry) => entry.pid), ...entries.flatMap((entry) => entry.childPid ? [entry.childPid] : [])]) {
    expect(() => process.kill(pid, 0)).toThrow()
  }
})

test('closing a workspace executor cancels its active turn and waits for descendant tools', async () => {
  const f = await fixture('hang')
  let closed: Promise<void> | undefined
  const result = await f.client.execute(f.input, (event) => {
    if (event.type === 'output' && event.event.text === 'Waiting') closed = f.client.close()
  })
  expect(result.status).toBe('cancelled')
  await closed
  const entries = await f.entries()
  for (const pid of [entries[0].pid, ...entries.flatMap((entry) => entry.childPid ? [entry.childPid] : [])]) {
    expect(() => process.kill(pid, 0)).toThrow()
  }
  expect((await f.client.execute({ ...f.input, taskId: 'later' }, () => {})).status).toBe('failed')
})

test('cancellation preserves main assistant text streamed before a completed block snapshot', async () => {
  const f = await fixture('partial-hang')
  const controller = new AbortController()
  const result = await f.client.execute({ ...f.input, signal: controller.signal }, (event) => {
    if (event.type === 'output' && event.event.text === 'Waiting') controller.abort()
  })
  expect(result.status).toBe('cancelled')
  expect(result.output).toBe('Waiting')
})

test('normalizes output snapshots, tool errors and invalid cumulative usage without replaying history', () => {
  const workspace = testWorkspace()
  const events: TaskEvent[] = []
  const output = new ClaudeCodeOutput({ workspace, taskId: 'output', cwd: workspace.home, prompt: '' }, (event) => { events.push(event) })
  output.setUsageBaseline({ fable: { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 10, cacheCreationInputTokens: 10 } })
  output.message({ type: 'assistant', historical: true, message: { id: 'old', content: [{ type: 'text', text: 'Old conversation' }] } })
  output.message({ type: 'assistant', message: { id: 'edit', content: [{ type: 'tool_use', id: 'failed-edit', name: 'Edit', input: { file_path: 'bad.ts' } }] } })
  output.message({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'failed-edit', content: 'Permission denied', is_error: true }] } })
  output.message({ type: 'result', result: 'Final answer', modelUsage: { fable: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } } })
  expect(output.output).toBe('Final answer')
  expect(output.changedFiles.size).toBe(0)
  expect(output.usage).toBeUndefined()
  expect(events.some((event) => event.type === 'output' && event.event.category === 'error' && event.event.text === 'Permission denied')).toBe(true)
  expect(events.filter((event) => event.type === 'usage')).toEqual([])
})
