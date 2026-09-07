import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { CodexAppServerClient } from '../src/main/agents/codex-app-server'
import { AgentProcessManager, type ExitInfo } from '../src/main/agents/process-manager'
import { getAgent } from '../src/main/agents/registry'
import type { TaskEvent, TaskInput } from '../src/main/agents/agent-executor'

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'anvil-codex-server-'))
  const fixture = resolve('tests/fixtures/codex-app-server.cjs')
  const transcript = join(directory, 'requests.jsonl')
  const input: TaskInput = {
    taskId: 'task-test', issueId: 'issue-test', prompt: 'Implement the issue',
    cwd: directory, model: 'test-model'
  }
  const clients: CodexAppServerClient[] = []
  const client = (scenario: string): CodexAppServerClient => {
    const executor = new CodexAppServerClient({
      command: process.execPath, args: [fixture, scenario, transcript], requestTimeoutMs: 5_000,
      cancelTimeoutMs: scenario === 'cancel-before-ack' ? 500 : 30
    })
    clients.push(executor)
    return executor
  }
  const events: TaskEvent[] = []
  const record = (event: TaskEvent): void => { events.push(event) }
  const requests = async (): Promise<any[]> => (await readFile(transcript, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const outputEvents = () => events.filter((event) => event.type === 'output').map((event) => event.event)
  const expected = 'Done ✓\nCompleted issue-test through vl. Tests passed.'
  const timeout = setTimeout(() => {
    console.error('Codex app-server tests timed out')
    process.exit(1)
  }, 30_000)
  try {
    const result = await client('success').execute(input, record)
    assert.equal(result.status, 'succeeded', result.error)
    assert.equal(result.sessionId, 'thread-test')
    assert.equal(result.issueId, 'issue-test')
    assert.equal(result.output, expected)
    assert.deepEqual(result.changedFiles, ['/changed.ts', '/renamed.ts'])
    assert.deepEqual(result.usage, { inputTokens: 40, outputTokens: 20, cachedTokens: 20, totalTokens: 60, costUsd: null })
    assert.deepEqual(outputEvents().filter((event) => event.category === 'message').map((event) => event.text), expected.split('\n'))
    assert.deepEqual(outputEvents().filter((event) => event.category === 'thinking').map((event) => event.text), ['Thinking'])
    assert.equal(outputEvents().filter((event) => event.text === 'Tests passed\n').length, 1)
    assert.ok(outputEvents().some((event) => event.stream === 'stderr' && event.text === 'trailing diagnostic'))
    assert.ok(outputEvents().every((event) => event.id && event.ts && event.taskId === input.taskId))
    assert.equal(events.filter((event) => event.type === 'session').length, 1)
    const initial = await requests()
    assert.deepEqual(initial.map((request) => request.method), ['initialize', 'initialized', 'thread/start', 'turn/start'])
    assert.ok(initial.every((request) => !('jsonrpc' in request)))
    assert.deepEqual(initial[0].params, { clientInfo: { name: 'anvil', title: 'Anvil', version: '0.1.0' } })
    assert.equal(initial[2].params.approvalPolicy, 'never')
    assert.equal(initial[2].params.sandbox, 'danger-full-access')
    assert.equal(initial[2].params.cwd, directory)
    assert.equal(initial[2].params.model, 'test-model')
    assert.deepEqual(initial[2].params.config, {
      'memories.use_memories': false,
      'memories.generate_memories': false,
      'features.recommended_plugins': false,
      tool_output_token_limit: 3000,
      'shell_environment_policy.set.PATH': process.env.PATH ?? ''
    }, 'Anvil tasks use project memory, not unrelated Codex personal context')
    assert.deepEqual(initial[3].params.input, [{ type: 'text', text: input.prompt, text_elements: [] }], 'Only the task prompt is sent, not the persisted event log')
    assert.equal(initial[3].params.cwd, directory)
    assert.deepEqual(initial[3].params.sandboxPolicy, {
      type: 'dangerFullAccess'
    }, 'Browser validation must run without the Codex OS sandbox')

    events.length = 0
    const resumed = await client('success').execute({ ...input, resumeSessionId: 'thread-test' }, record)
    assert.equal(resumed.output, expected)
    assert.deepEqual(resumed.usage, result.usage, 'Subtract a pre-turn baseline, not last or the full thread history')
    assert.ok(!outputEvents().some((event) => /old history|old issue/.test(event.text)))
    const resumeRequest = (await requests()).find((request) => request.method === 'thread/resume')
    assert.equal(resumeRequest.params.threadId, 'thread-test')
    assert.equal(resumeRequest.params.sandbox, 'danger-full-access')
    assert.equal(resumeRequest.params.approvalPolicy, 'never')
    assert.deepEqual(resumeRequest.params.config, initial[2].params.config)
    const unknownUsage = await client('no-baseline').execute({ ...input, resumeSessionId: 'thread-test' }, () => {})
    assert.equal(unknownUsage.usage, undefined, 'Never charge resumed history when Codex supplies no baseline')

    for (const scenario of ['snapshot-only', 'early-events', 'revision']) {
      const final = await client(scenario).execute(input, () => {})
      assert.equal(final.status, 'succeeded', `${scenario}: ${final.error}`)
      assert.equal(final.output, expected, scenario)
    }
    for (const scenario of ['failure', 'invalid-status', 'bad-thread', 'rpc-error', 'exit', 'malformed', 'eof']) {
      const failed = await client(scenario).execute(input, () => {})
      assert.equal(failed.status, 'failed', scenario)
      assert.ok(failed.error, scenario)
      if (scenario === 'failure') assert.match(failed.error!, /Provider rejected/)
    }
    if (process.platform !== 'win32') assert.equal((await client('orphan').execute(input, () => {})).status, 'failed')
    assert.equal((await client('interrupted').execute(input, () => {})).status, 'cancelled')
    const startup = await new CodexAppServerClient({
      command: process.execPath, args: [fixture, 'startup-hang', transcript], requestTimeoutMs: 30
    }).execute(input, () => {})
    assert.match(startup.error!, /initialize request timed out/)

    assert.equal((await client('permissions').execute(input, () => {})).status, 'succeeded')
    const permissionResponses = (await requests()).filter((request) => !request.method && request.id !== undefined)
    assert.equal(permissionResponses.find((response) => response.id === 1).result.decision, 'accept')
    assert.equal(permissionResponses.find((response) => response.id === 'file').result.decision, 'accept')
    assert.deepEqual(permissionResponses.find((response) => response.id === 'permissions').result, { permissions: { network: { enabled: true } }, scope: 'turn' })
    for (const requestId of ['stale-command', 'foreign-command']) {
      assert.equal(permissionResponses.find((response) => response.id === requestId).result.decision, 'cancel')
    }
    for (const requestId of ['stale-permissions', 'foreign-permissions']) {
      assert.deepEqual(permissionResponses.find((response) => response.id === requestId).result, { permissions: {}, scope: 'turn' })
    }
    assert.deepEqual(permissionResponses.find((response) => response.id === 'elicitation').result, { action: 'cancel', content: null })
    assert.deepEqual(permissionResponses.find((response) => response.id === 'input').result, { answers: {} })
    assert.equal(permissionResponses.find((response) => response.id === 'unknown').error.code, -32601)

    for (const scenario of ['steer', 'steer-error']) {
      const executor = client(scenario)
      let ready!: () => void
      const started = new Promise<void>((resolve) => { ready = resolve })
      const execution = executor.execute(input, (event) => {
        if (event.type === 'output' && event.event.text === 'Waiting for steering') ready()
      })
      await started
      const steering = { taskId: input.taskId, sessionId: 'thread-test', message: 'Adjust validation' }
      await assert.rejects(executor.steer({ ...steering, taskId: 'other-task' }), /no active/)
      await assert.rejects(executor.steer({ ...steering, sessionId: 'old-thread' }), /session changed/)
      await assert.rejects(executor.steer({ ...steering, message: ' ' }), /needs some text/)
      if (scenario === 'steer-error') await assert.rejects(executor.steer(steering), /Steering not permitted/)
      await executor.steer(steering)
      assert.equal((await execution).status, 'succeeded')
      await assert.rejects(executor.steer(steering), /no active/)
    }
    const steeringRequests = (await requests()).filter((request) => request.method === 'turn/steer')
    assert.equal(steeringRequests.length, 3)
    assert.deepEqual(steeringRequests[0].params, {
      threadId: 'thread-test', expectedTurnId: 'turn-test',
      input: [{ type: 'text', text: 'Adjust validation', text_elements: [] }]
    })

    const steeringManager = new AgentProcessManager(undefined, client('steer'))
    let managerReady!: () => void
    const managerStarted = new Promise<void>((resolve) => { managerReady = resolve })
    steeringManager.on('event', (event) => { if (event.text === 'Waiting for steering') managerReady() })
    const steeringExit = once(steeringManager, 'exit')
    steeringManager.start({ ...input, agent: getAgent('codex')! })
    await managerStarted
    await steeringManager.steer({ taskId: input.taskId, sessionId: 'thread-test', message: 'Adjust validation' })
    assert.equal(((await steeringExit) as [ExitInfo])[0].code, 0)
    await assert.rejects(steeringManager.steer({ taskId: input.taskId, sessionId: 'thread-test', message: 'Adjust validation' }), /no active/)

    for (const scenario of ['cancel', 'cancel-hang', 'cancel-before-ack']) {
      const controller = new AbortController()
      const cancelled = await client(scenario).execute({ ...input, signal: controller.signal }, (event) => {
        if (event.type === 'output' && ['Waiting', 'Abort before acknowledgement'].includes(event.event.text)) controller.abort()
      })
      assert.equal(cancelled.status, 'cancelled', scenario)
    }
    assert.ok((await requests()).some((request) => request.method === 'turn/interrupt'))
    const controller = new AbortController()
    controller.abort()
    assert.equal((await client('success').execute({ ...input, signal: controller.signal }, () => {})).status, 'cancelled')
    const duringStartup = new AbortController()
    const pendingStartup = client('startup-hang').execute({ ...input, signal: duringStartup.signal }, () => {})
    duringStartup.abort()
    assert.equal((await pendingStartup).status, 'cancelled')
    assert.match((await new CodexAppServerClient({ command: '/missing-codex' }).execute(input, () => {})).error!, /not installed/)
    assert.equal((await client('success').execute({ ...input, cwd: join(directory, 'missing') }, () => {})).status, 'failed')
    assert.match((await client('success').execute({ ...input, cwd: '.' }, () => {})).error!, /absolute/)

    const manager = new AgentProcessManager(undefined, client('success'))
    const forwarded: string[] = []
    for (const name of ['event', 'session', 'usage']) manager.on(name, () => forwarded.push(name))
    const exited = once(manager, 'exit')
    manager.start({ ...input, agent: getAgent('codex')! })
    assert.equal(manager.isRunning(input.taskId), true)
    assert.throws(() => manager.start({ ...input, agent: getAgent('codex')! }), /already running/)
    const [exit] = await exited as [ExitInfo]
    assert.equal(exit.code, 0)
    assert.equal(exit.result?.output, expected)
    assert.equal(manager.isRunning(input.taskId), false)
    assert.ok(['event', 'session', 'usage'].every((name) => forwarded.includes(name)))
    const cancellation = new AgentProcessManager(undefined, client('cancel-hang'))
    const cancelledExit = once(cancellation, 'exit')
    cancellation.start({ ...input, agent: getAgent('codex')! })
    cancellation.cancelAll()
    assert.equal(((await cancelledExit) as [ExitInfo])[0].cancelled, true)
    assert.equal(cancellation.isRunning(input.taskId), false)
    console.log('Codex app-server tests passed: handshake, threads, turns, scoped output, snapshots, usage, permissions, cancellation, errors, and manager integration.')
  } finally {
    await Promise.all(clients.map((executor) => executor.close()))
    clearTimeout(timeout)
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
