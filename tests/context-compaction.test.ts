import { expect, test, vi } from 'vitest'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { contextOccupancy, CONTEXT_COMPACTED, shouldCompactContext } from '../src/shared/task-context'
import { CodexAppServerOutput } from '../src/server/agents/codex-app-server-output'
import { AcpOutput } from '../src/server/agents/acp-output'
import { CodexAppServerClient } from '../src/server/agents/codex-app-server'
import { OpenCodeAcpClient } from '../src/server/agents/opencode-acp'
import { AgentProcessManager } from '../src/server/agents/process-manager'
import { getAgent } from '../src/server/agents/registry'
import type { AgentExecutor, TaskEvent, TaskInput, TaskResult } from '../src/server/agents/agent-executor'
import { testWorkspace } from './workspace-fixture'
import { onTestCleanup } from './test-cleanup'

const input = (): TaskInput => ({ workspace: testWorkspace(), taskId: 'task', cwd: process.cwd(), prompt: 'Implement the issue' })
const result = (): TaskResult => ({ taskId: 'task', status: 'succeeded', output: '', changedFiles: [] })

test('occupancy is separate from billed usage and compaction items are deduplicated system markers', () => {
  const events: TaskEvent[] = []
  const output = new CodexAppServerOutput(input(), (event) => events.push(event))
  output.updateUsage({ total: { inputTokens: 90000, outputTokens: 1000, cachedInputTokens: 50000, totalTokens: 91000 }, last: { totalTokens: 750 }, modelContextWindow: 1000 }, true)
  expect(events.find((event) => event.type === 'context')).toMatchObject({ contextUsed: 750, contextSize: 1000 })
  expect(events.find((event) => event.type === 'usage')).toMatchObject({ usage: { totalTokens: 91000 } })
  for (const complete of [false, true, true]) output.item({ id: 'compaction', type: 'contextCompaction' }, complete)
  const lines = events.filter((event) => event.type === 'output').map((event) => event.event)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ category: 'system', stream: 'system', text: CONTEXT_COMPACTED })
  const acpEvents: TaskEvent[] = []
  const acp = new AcpOutput(input(), (event) => acpEvents.push(event))
  acp.update({ sessionUpdate: 'usage_update', used: 800, size: 1000 })
  expect(acpEvents).toEqual([{ type: 'context', taskId: 'task', contextUsed: 800, contextSize: 1000 }])
  expect(acp.usage).toBeUndefined()
})

test('automatic compaction requires a resumed session, known occupancy and the workspace threshold', () => {
  const task = { sessionId: 'session', contextUsed: 750, contextSize: 1000 }
  expect(shouldCompactContext(task, {})).toBe(true)
  for (const patch of [{ sessionId: undefined }, { contextSize: null }, { contextSize: 0 }, { contextUsed: null }, { contextUsed: 749 }]) {
    expect(shouldCompactContext({ ...task, ...patch }, {})).toBe(false)
  }
  expect(shouldCompactContext(task, { autoCompactContext: false })).toBe(false)
  expect(shouldCompactContext(task, { contextCompactionThreshold: 80 })).toBe(false)
  expect(contextOccupancy(NaN, Infinity)).toEqual({ contextUsed: null, contextSize: null })
})

test('compaction locks out coding and steering, waits before resuming, and never emits a task exit for manual compaction', async () => {
  let finish!: () => void
  const compact = vi.fn(async () => { await new Promise<void>((resolve) => { finish = resolve }); return result() })
  const execute = vi.fn(async (turn: TaskInput) => { turn.onStarted?.(); return result() })
  const client: AgentExecutor = { compact, execute, steer: vi.fn() }
  const manager = new AgentProcessManager(undefined, client)
  onTestCleanup(() => manager.close())
  const opts = { ...input(), agent: getAgent('codex')!, resumeSessionId: 'session' }
  const manualExit = vi.fn()
  manager.on('exit', manualExit)
  const manual = manager.compact(opts)
  await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(1))
  expect(manager.isRunning(opts.taskId)).toBe(true)
  expect(() => manager.start(opts)).toThrow('already running')
  await expect(manager.compact(opts)).rejects.toThrow('active turn')
  await expect(manager.steer({ taskId: opts.taskId, sessionId: 'session', message: 'Work' })).rejects.toThrow('does not support steering')
  finish()
  await manual
  expect(manualExit).not.toHaveBeenCalled()
  expect(manager.isRunning(opts.taskId)).toBe(false)
  const exited = once(manager, 'exit')
  const resumed = manager.startResumed({ ...opts, autoCompact: true })
  await vi.waitFor(() => expect(compact).toHaveBeenCalledTimes(2))
  expect(execute).not.toHaveBeenCalled()
  finish()
  await resumed
  await exited
  expect(execute).toHaveBeenCalledTimes(1)
})

test('failed compaction prevents a coding turn and releases its lock', async () => {
  const execute = vi.fn()
  const manager = new AgentProcessManager(undefined, { execute, compact: async () => ({ ...result(), status: 'failed', error: 'Context failed' }) })
  onTestCleanup(() => manager.close())
  const events: unknown[] = []
  manager.on('compaction', (event) => events.push(event))
  await expect(manager.startResumed({ ...input(), agent: getAgent('codex')!, resumeSessionId: 'session', autoCompact: true })).rejects.toThrow('Context failed')
  expect(execute).not.toHaveBeenCalled()
  expect(manager.isRunning('task')).toBe(false)
  expect(events.at(-1)).toMatchObject({ running: false, error: 'Context failed' })
})

test('manual compaction cannot interrupt a coding turn and fresh sessions skip automatic compaction', async () => {
  const compact = vi.fn()
  const manager = new AgentProcessManager(undefined, {
    compact,
    execute: async (turn) => {
      turn.onStarted?.()
      await new Promise<void>((resolve) => turn.signal!.addEventListener('abort', () => resolve(), { once: true }))
      return { ...result(), status: 'cancelled' }
    }
  })
  onTestCleanup(() => manager.close())
  const opts = { ...input(), agent: getAgent('codex')!, autoCompact: true }
  const exited = once(manager, 'exit')
  await manager.startResumed(opts)
  await expect(manager.compact({ ...opts, resumeSessionId: 'session' })).rejects.toThrow('active turn')
  expect(compact).not.toHaveBeenCalled()
  manager.cancel('task')
  await exited
})

test('automatic compaction preserves explicit missing-session recovery', async () => {
  const execute = vi.fn(async (turn: TaskInput) => { turn.onStarted?.(); return result() })
  const manager = new AgentProcessManager(undefined, {
    execute,
    compact: async () => ({ ...result(), status: 'failed', error: 'no rollout found for thread id missing' })
  })
  onTestCleanup(() => manager.close())
  const exited = once(manager, 'exit')
  await manager.startResumed({ ...input(), agent: getAgent('codex')!, autoCompact: true, resumeSessionId: 'missing', resumeFallbackPrompt: 'Recover saved plan' })
  await exited
  expect(execute.mock.calls[0][0].resumeFallbackPrompt).toBe('Recover saved plan')
})

test.each(['codex', 'opencode'] as const)('%s compacts the saved session through its transport', async (agent) => {
  const directory = await mkdtemp(join(tmpdir(), 'anvil-compact-'))
  onTestCleanup(() => rm(directory, { recursive: true, force: true }))
  const transcript = join(directory, 'requests.jsonl')
  const args = [resolve(`tests/fixtures/${agent === 'codex' ? 'codex-app-server' : 'opencode-acp'}.cjs`), 'compact', transcript]
  const turn = { ...input(), cwd: directory, model: agent === 'codex' ? 'test-model' : 'provider/model', resumeSessionId: agent === 'codex' ? 'thread-test' : 'session-test' }
  const client = agent === 'codex'
    ? new CodexAppServerClient({ workspace: turn.workspace, command: process.execPath, args })
    : new OpenCodeAcpClient({ command: process.execPath, args })
  onTestCleanup(() => client.close())
  const events: TaskEvent[] = []
  const compacted = await client.compact(turn, (event) => events.push(event))
  expect(compacted.status, compacted.error).toBe('succeeded')
  expect(events.filter((event) => event.type === 'context').at(-1)).toMatchObject({ contextUsed: 120, contextSize: 1000 })
  const requests = (await readFile(transcript, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  expect(requests.some((request) => request.method === (agent === 'codex' ? 'thread/resume' : 'session/load'))).toBe(true)
  if (agent === 'codex') {
    expect(requests.some((request) => request.method === 'thread/compact/start')).toBe(true)
    expect(requests.some((request) => request.method === 'turn/start')).toBe(false)
    expect(events.filter((event) => event.type === 'output' && event.event.text === CONTEXT_COMPACTED)).toHaveLength(1)
  } else {
    expect(requests.find((request) => request.method === 'session/prompt').params.prompt).toEqual([{ type: 'text', text: '/compact' }])
  }
})
