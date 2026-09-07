import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
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
    const discoveryClient = client('models')
    assert.deepEqual(await discoveryClient.listModels(directory), {
      models: ['reasoner', 'plain'],
      reasoningByModel: {
        reasoner: { options: [{ id: 'native-max', label: 'Maximum reasoning' }, { id: 'low', label: 'Fast reasoning' }], default: 'native-max' },
        plain: { options: [], default: 'none' }
      }
    })
    const discoveredRequests = await requests()
    assert.deepEqual(discoveredRequests.filter((entry) => entry.method === 'model/list').map((entry) => entry.params), [{}, { cursor: 'page-2' }])
    assert.equal(discoveredRequests.some((entry) => entry.method === 'thread/start'), false)
    const sharedExecution = await discoveryClient.execute(input, () => {})
    assert.equal(sharedExecution.status, 'succeeded')
    assert.equal((await requests()).filter((entry) => entry.method === 'initialize').length, 1, 'Discovery and execution reuse the server')
    await discoveryClient.close()
    assert.deepEqual(await client('models-empty').listModels(directory), { models: [], reasoningByModel: {} })
    await assert.rejects(client('models-error').listModels(directory), /Discovery unavailable/)
    await assert.rejects(client('models-malformed').listModels(directory), /string|reasoning/)
    await assert.rejects(client('models-cycle').listModels(directory), /pagination cursor/)
    const hangingDiscovery = client('models-hang')
    const pendingDiscovery = hangingDiscovery.listModels(directory)
    const rejectedDiscovery = assert.rejects(pendingDiscovery, /closed|shutting down/)
    await hangingDiscovery.close()
    await rejectedDiscovery
    await writeFile(transcript, '')
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
    assert.equal(initial[2].params.sandbox, 'workspace-write')
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
      type: 'workspaceWrite', writableRoots: [await realpath(directory)], networkAccess: true,
      excludeTmpdirEnvVar: false, excludeSlashTmp: false
    }, 'Headless validation needs network access for dependencies and local test servers')

    for (const { resumeSessionId, reasoningEffort } of [
      { resumeSessionId: undefined, reasoningEffort: 'native-max' },
      { resumeSessionId: 'thread-test', reasoningEffort: 'low' },
      { resumeSessionId: undefined, reasoningEffort: undefined },
      { resumeSessionId: 'thread-test', reasoningEffort: undefined }
    ]) {
      await writeFile(transcript, '')
      const configured = await client('success').execute({ ...input, model: 'reasoner', reasoningEffort, resumeSessionId }, () => {})
      assert.equal(configured.status, 'succeeded', configured.error)
      const calls = await requests()
      const thread = calls.find((entry) => entry.method === (resumeSessionId ? 'thread/resume' : 'thread/start'))
      assert.equal(thread.params.config.model_reasoning_effort, reasoningEffort)
      assert.equal('model_reasoning_effort' in thread.params.config, reasoningEffort !== undefined)
      assert.equal(thread.params.threadId, resumeSessionId)
      assert.equal('reasoningEffort' in thread.params, false, 'Only protocol settings go on the wire')
      assert.equal(calls.some((entry) => entry.method === 'model/list'), reasoningEffort !== undefined)
    }
    for (const model of ['reasoner', 'plain', undefined]) {
      await writeFile(transcript, '')
      const invalid = await client('success').execute({ ...input, model, reasoningEffort: 'removed-option', resumeSessionId: 'thread-test' }, () => {})
      assert.equal(invalid.status, 'failed')
      assert.match(invalid.error!, /does not advertise reasoning effort removed-option/)
      assert.equal((await requests()).some((entry) => entry.method.startsWith('thread/') || entry.method === 'turn/start'), false)
    }
    await writeFile(transcript, '')
    const rejected = await client('rejected-effort').execute({ ...input, model: 'reasoner', reasoningEffort: 'native-max' }, () => {})
    assert.equal(rejected.status, 'failed')
    assert.match(rejected.error!, /Codex rejected thread options with reasoning effort native-max.*Effort rejected/)
    assert.equal((await requests()).some((entry) => entry.method === 'turn/start'), false)

    events.length = 0
    const resumed = await client('success').execute({ ...input, resumeSessionId: 'thread-test' }, record)
    assert.equal(resumed.output, expected)
    assert.deepEqual(resumed.usage, result.usage, 'Subtract a pre-turn baseline, not last or the full thread history')
    assert.ok(!outputEvents().some((event) => /old history|old issue/.test(event.text)))
    const resumeRequest = (await requests()).find((request) => request.method === 'thread/resume')
    assert.equal(resumeRequest.params.threadId, 'thread-test')
    assert.equal(resumeRequest.params.sandbox, 'workspace-write')
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
    assert.ok(permissionResponses.some((response) => response.result?.decision === 'decline'))
    assert.deepEqual(permissionResponses.find((response) => response.id === 'permissions').result, { permissions: {}, scope: 'turn' })
    assert.deepEqual(permissionResponses.find((response) => response.id === 'elicitation').result, { action: 'cancel', content: null })
    assert.deepEqual(permissionResponses.find((response) => response.id === 'input').result, { answers: {} })
    assert.equal(permissionResponses.find((response) => response.id === 'unknown').error.code, -32601)

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
