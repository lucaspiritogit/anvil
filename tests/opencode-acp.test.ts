import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { OpenCodeAcpClient } from '../src/main/agents/opencode-acp'
import { AgentProcessManager, type ExitInfo } from '../src/main/agents/process-manager'
import { getAgent } from '../src/main/agents/registry'
import { completionEvidence } from '../src/main/issue-tracker'
import type { TaskEvent, TaskInput } from '../src/main/agents/agent-client-protocol'

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'anvil-acp-'))
  const fixture = resolve('tests/fixtures/opencode-acp.cjs')
  const transcript = join(directory, 'requests.jsonl')
  const input: TaskInput = {
    taskId: 'task-test', issueId: 'issue-test', prompt: 'Implement the issue',
    cwd: directory, model: 'provider/model'
  }
  const client = (scenario: string): OpenCodeAcpClient => new OpenCodeAcpClient({
    command: process.execPath, args: [fixture, scenario, transcript], startupTimeoutMs: 5_000, cancelTimeoutMs: 30
  })
  const requests = async (): Promise<any[]> => (await readFile(transcript, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const events: TaskEvent[] = []
  const record = (event: TaskEvent): void => { events.push(event) }
  // Bound the suite even if process shutdown regresses.
  const timeout = setTimeout(() => {
    console.error('ACP tests timed out')
    process.exit(1)
  }, 30_000)
  try {
    const result = await client('success').execute(input, record)
    assert.equal(result.status, 'succeeded', result.error)
    assert.equal(result.taskId, input.taskId)
    assert.equal(result.issueId, input.issueId)
    assert.equal(result.sessionId, 'session-test')
    assert.deepEqual(result.changedFiles, ['/changed.ts'])
    assert.deepEqual(result.usage, { inputTokens: 20, outputTokens: 10, cachedTokens: 5, totalTokens: 35, costUsd: 0.25 })
    const expected = 'Done ✓\n<anvil-issue-tracker>{"id":"issue-test","status":"complete","checklist":[true],"evidence":"Tests passed"}</anvil-issue-tracker>'
    assert.equal(result.output, expected)
    const outputEvents = events.filter((event) => event.type === 'output').map((event) => event.event)
    assert.deepEqual(outputEvents.filter((event) => event.category === 'message').map((event) => event.text), expected.split('\n'))
    assert.ok(outputEvents.some((event) => event.category === 'thinking' && event.text === 'Thinking'))
    assert.ok(outputEvents.some((event) => event.category === 'tool_result' && event.text === 'Tests passed'))
    assert.ok(outputEvents.some((event) => event.category === 'error' && event.text === 'Failed edit: failed'))
    assert.ok(outputEvents.some((event) => event.stream === 'stderr' && event.text === 'trailing diagnostic'))
    assert.ok(outputEvents.every((event) => event.id && event.ts && event.taskId === input.taskId))
    assert.equal(completionEvidence(result.output, { id: 'issue-test', checklist: ['Run tests'] } as Parameters<typeof completionEvidence>[1]), 'Tests passed')
    assert.equal(events.filter((event) => event.type === 'session').length, 1)
    assert.equal(events.filter((event) => event.type === 'usage').length, 1)
    const initialRequests = await requests()
    assert.deepEqual(initialRequests.filter((request) => request.method).map((request) => request.method), [
      'initialize', 'session/new', 'session/set_config_option', 'session/prompt'
    ])
    assert.deepEqual(initialRequests[0].params.clientCapabilities, {})
    assert.deepEqual(initialRequests[1].params.mcpServers, [])
    assert.equal(initialRequests.find((request) => request.id === 'permission').result.outcome.optionId, 'once')

    events.length = 0
    const resumed = await client('success').execute({ ...input, resumeSessionId: 'session-test' }, record)
    assert.equal(resumed.output, expected)
    assert.deepEqual(resumed.changedFiles, ['/changed.ts'])
    assert.equal(resumed.usage?.costUsd, null, 'Do not charge session-cumulative cost again on resume')
    assert.ok(!events.some((event) => event.type === 'output' && /history|Old edit/.test(event.event.text)))
    assert.ok((await requests()).some((request) => request.method === 'session/load'))

    for (const scenario of ['refusal', 'max-tokens', 'rpc-error', 'exit', 'malformed', 'version']) {
      const failed = await client(scenario).execute(input, () => {})
      assert.equal(failed.status, 'failed', scenario)
      assert.ok(failed.error, scenario)
    }
    if (process.platform !== 'win32') {
      assert.equal((await client('orphan').execute(input, () => {})).status, 'failed', 'Clean up inherited pipes when the server exits')
    }
    const unsupported = await client('no-resume').execute({ ...input, resumeSessionId: 'session-test' }, () => {})
    assert.match(unsupported.error!, /does not support loading/)
    const denied = await client('deny-only').execute(input, () => {})
    assert.equal(denied.status, 'succeeded', 'Permission cancellation should not break JSON-RPC')
    const startup = await new OpenCodeAcpClient({
      command: process.execPath, args: [fixture, 'startup-hang', transcript], startupTimeoutMs: 30
    }).execute(input, () => {})
    assert.match(startup.error!, /startup timed out/)

    for (const scenario of ['cancel', 'cancel-hang']) {
      const controller = new AbortController()
      const cancelled = await client(scenario).execute({ ...input, signal: controller.signal }, (event) => {
        if (event.type === 'output' && event.event.text === 'Waiting') controller.abort()
      })
      assert.equal(cancelled.status, 'cancelled', scenario)
      assert.equal(cancelled.output, 'Waiting\n')
    }
    assert.ok((await requests()).some((request) => request.method === 'session/cancel'))
    const preCancelled = new AbortController()
    preCancelled.abort()
    assert.equal((await client('success').execute({ ...input, signal: preCancelled.signal }, () => {})).status, 'cancelled')
    assert.match((await new OpenCodeAcpClient({ command: '/anvil-missing-opencode' }).execute(input, () => {})).error!, /not installed/)
    assert.equal((await client('success').execute({ ...input, cwd: join(directory, 'missing') }, () => {})).status, 'failed')
    assert.match((await client('success').execute({ ...input, cwd: '.' }, () => {})).error!, /absolute/)

    const manager = new AgentProcessManager(client('success'))
    const forwarded: string[] = []
    for (const name of ['event', 'session', 'usage']) manager.on(name, () => forwarded.push(name))
    const exited = once(manager, 'exit')
    manager.start({ ...input, agent: getAgent('opencode')! })
    assert.equal(manager.isRunning(input.taskId), true)
    assert.throws(() => manager.start({ ...input, agent: getAgent('opencode')! }), /already running/)
    const [exit] = await exited as [ExitInfo]
    assert.equal(exit.code, 0)
    assert.equal(exit.result?.output, expected)
    assert.equal(manager.isRunning(input.taskId), false)
    assert.ok(['event', 'session', 'usage'].every((name) => forwarded.includes(name)))
    const cancellationManager = new AgentProcessManager(client('cancel-hang'))
    const cancelledExit = once(cancellationManager, 'exit')
    cancellationManager.start({ ...input, agent: getAgent('opencode')! })
    cancellationManager.cancelAll()
    assert.equal(((await cancelledExit) as [ExitInfo])[0].cancelled, true)
    assert.equal(cancellationManager.isRunning(input.taskId), false)
    console.log('OpenCode ACP tests passed: handshake, model, permissions, output, issue evidence, sessions, usage, failures, cancellation, and manager integration.')
  } finally {
    clearTimeout(timeout)
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
