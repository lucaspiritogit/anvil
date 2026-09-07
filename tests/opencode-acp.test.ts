import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { OpenCodeAcpClient } from '../src/main/agents/opencode-acp'
import { AgentProcessManager, type ExitInfo } from '../src/main/agents/process-manager'
import { getAgent } from '../src/main/agents/registry'
import type { TaskEvent, TaskInput } from '../src/main/agents/agent-client-protocol'

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'anvil-acp-'))
  const fixture = resolve('tests/fixtures/opencode-acp.cjs')
  const transcript = join(directory, 'requests.jsonl')
  const input: TaskInput = {
    taskId: 'task-test', issueId: 'issue-test', prompt: 'Implement the issue',
    cwd: directory, model: 'provider/model'
  }
  const clients: OpenCodeAcpClient[] = []
  const client = (scenario: string): OpenCodeAcpClient => {
    const executor = new OpenCodeAcpClient({
      command: process.execPath, args: [fixture, scenario, transcript], startupTimeoutMs: 5_000, cancelTimeoutMs: 30
    })
    clients.push(executor)
    return executor
  }
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
    const expected = 'Done ✓\nCompleted issue-test through vl. Tests passed.'
    assert.equal(result.output, expected)
    const outputEvents = events.filter((event) => event.type === 'output').map((event) => event.event)
    assert.deepEqual(outputEvents.filter((event) => event.category === 'message').map((event) => event.text), expected.split('\n'))
    assert.ok(outputEvents.some((event) => event.category === 'thinking' && event.text === 'Thinking'))
    assert.ok(outputEvents.some((event) => event.category === 'tool_result' && event.text === 'Tests passed'))
    assert.ok(outputEvents.some((event) => event.category === 'error' && event.text === 'Failed edit: failed'))
    assert.ok(outputEvents.some((event) => event.stream === 'stderr' && event.text === 'trailing diagnostic'))
    assert.ok(outputEvents.every((event) => event.id && event.ts && event.taskId === input.taskId))
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

    const openrouterModel = 'openrouter/anthropic/claude-sonnet-4-6'
    const openrouter = await client('openrouter').execute({ ...input, model: openrouterModel }, () => {})
    assert.equal(openrouter.status, 'succeeded', openrouter.error)
    const modelRequest = (await requests()).findLast((request) => request.method === 'session/set_config_option')
    assert.equal(modelRequest.params.value, openrouterModel, 'Keep the OpenRouter route so OpenCode uses that provider\'s credentials')

    for (const scenario of ['limited-effort', 'removed-effort', 'success']) {
      events.length = 0
      const requestCount = (await requests()).length
      const limitedEffort = await client(scenario).execute({ ...input, reasoningEffort: 'medium' }, record)
      assert.equal(limitedEffort.status, 'failed', limitedEffort.error)
      assert.equal((await requests()).slice(requestCount).some((request) => request.method === 'session/prompt'), false)
      assert.ok(!events.some((event) => event.type === 'output' && /effort not found: medium/.test(event.event.text)),
        'Do not send medium when the selected model does not advertise that effort')
      assert.ok(!(await requests()).slice(requestCount).some((request) => request.params?.configId === 'effort'), scenario)
      assert.ok(events.some((event) => event.type === 'output' && /does not advertise reasoning effort/.test(event.event.text)), scenario)
      if (scenario === 'limited-effort') {
        assert.ok(events.some((event) => event.type === 'output' && /Available efforts: high/.test(event.event.text)))
      }
    }

    for (const selection of [
      { scenario: 'limited-effort', options: { reasoningEffort: 'high' as const } },
      { scenario: 'grouped-effort', options: { reasoningEffort: 'medium' as const } },
      { scenario: 'grouped-effort', options: { reasoningEffort: 'medium' as const, resumeSessionId: 'session-test' } },
      { scenario: 'session-effort', options: { model: undefined, reasoningEffort: 'medium' as const } },
      { scenario: 'session-effort', options: { model: undefined, reasoningEffort: 'medium' as const, resumeSessionId: 'session-test' } }
    ]) {
      const requestCount = (await requests()).length
      const configured = await client(selection.scenario).execute({ ...input, ...selection.options }, () => {})
      assert.equal(configured.status, 'succeeded', configured.error)
      const effortRequests = (await requests()).slice(requestCount).filter((request) => ['effort', 'native-reasoning'].includes(request.params?.configId))
      assert.deepEqual(effortRequests.map((request) => request.params.value), [selection.options.reasoningEffort])
    }

    for (const { reasoningEffort, resumeSessionId } of [
      { reasoningEffort: 'max', resumeSessionId: undefined },
      { reasoningEffort: 'high', resumeSessionId: 'session-test' },
      { reasoningEffort: 'medium', resumeSessionId: undefined },
      { reasoningEffort: undefined, resumeSessionId: undefined },
      { reasoningEffort: undefined, resumeSessionId: 'session-test' }
    ]) {
      const requestCount = (await requests()).length
      const nativeEffort = await client('native-effort').execute({ ...input, reasoningEffort, resumeSessionId }, () => {})
      assert.equal(nativeEffort.status, reasoningEffort === 'medium' ? 'failed' : 'succeeded', nativeEffort.error)
      const effortRequests = (await requests()).slice(requestCount).filter((request) => ['effort', 'native-reasoning'].includes(request.params?.configId))
      assert.deepEqual(effortRequests.map((request) => request.params.value), reasoningEffort && reasoningEffort !== 'medium' ? [reasoningEffort] : [],
        'Native model efforts must also be checked against the current ACP config')
    }

    events.length = 0
    const rejectedEffort = await client('rejected-effort').execute({ ...input, reasoningEffort: 'medium' }, record)
    assert.equal(rejectedEffort.status, 'failed', 'Rejected explicit effort must prevent prompting')
    assert.ok(events.some((event) => event.type === 'output' && /OpenCode rejected reasoning effort medium/.test(event.event.text)))

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

    for (const scenario of ['cancel', 'cancel-hang', 'cancel-partial']) {
      const controller = new AbortController()
      const cancellationEvents: TaskEvent[] = []
      const cancelled = await client(scenario).execute({ ...input, signal: controller.signal }, (event) => {
        cancellationEvents.push(event)
        if (event.type === 'output' && event.event.text === 'Waiting') controller.abort()
      })
      assert.equal(cancelled.status, 'cancelled', scenario)
      assert.equal(cancelled.output, scenario === 'cancel-partial' ? 'Waiting' : 'Waiting\n')
      if (scenario === 'cancel-partial') {
        const eventCount = cancellationEvents.length
        await delay(300)
        assert.equal(cancellationEvents.length, eventCount, 'No timed flush or late update after cancellation')
        assert.equal(cancellationEvents.filter(event => event.type === 'output' && event.event.text === 'Waiting').length, 1)
      }
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
    await Promise.all(clients.map((executor) => executor.close()))
    clearTimeout(timeout)
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
