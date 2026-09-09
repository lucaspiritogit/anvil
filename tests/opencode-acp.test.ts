import { taskImages } from './task-image-fixture'
import { onTestCleanup } from './test-cleanup'
import { expect, test } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { OpenCodeAcpClient } from '../src/main/agents/opencode-acp'
import { AgentProcessManager, type ExitInfo } from '../src/main/agents/process-manager'
import { getAgent } from '../src/main/agents/registry'
import type { TaskEvent, TaskInput } from '../src/main/agents/agent-client-protocol'

test('handles ACP sessions, output, permissions, recovery and cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anvil-acp-'))
  onTestCleanup(() => rm(directory, { recursive: true, force: true }))
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
    onTestCleanup(() => executor.close())
    clients.push(executor)
    return executor
  }
  const requests = async (): Promise<any[]> => (await readFile(transcript, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const events: TaskEvent[] = []
  const record = (event: TaskEvent): void => { events.push(event) }
  try {
    const result = await client('success').execute(input, record)
    expect(result.status, result.error).toBe('succeeded')
    expect(result.taskId).toBe(input.taskId)
    expect(result.issueId).toBe(input.issueId)
    expect(result.sessionId).toBe('session-test')
    expect(result.changedFiles).toStrictEqual(['/changed.ts'])
    expect(result.usage).toStrictEqual({ inputTokens: 20, outputTokens: 10, cachedTokens: 5, totalTokens: 35, costUsd: 0.25 })
    const expected = 'Done ✓\nCompleted issue-test through vl. Tests passed.'
    expect(result.output).toBe(expected)
    const outputEvents = events.filter((event) => event.type === 'output').map((event) => event.event)
    expect(outputEvents.filter((event) => event.category === 'message').map((event) => event.text)).toStrictEqual([expected])
    expect(outputEvents.some((event) => event.category === 'thinking' && event.text === 'Thinking\n')).toBeTruthy()
    expect(outputEvents.some((event) => event.category === 'tool_result' && event.text === 'Tests passed')).toBeTruthy()
    expect(outputEvents.some((event) => event.category === 'error' && event.text === 'Failed edit: failed')).toBeTruthy()
    expect(outputEvents.some((event) => event.stream === 'stderr' && event.text === 'trailing diagnostic')).toBeTruthy()
    expect(outputEvents.every((event) => event.id && event.ts && event.taskId === input.taskId && event.issueId === input.issueId)).toBeTruthy()
    expect(events.filter((event) => event.type === 'session').length).toBe(1)
    expect(events.filter((event) => event.type === 'usage').length).toBe(1)
    const initialRequests = await requests()
    expect(initialRequests.filter((request) => request.method).map((request) => request.method)).toStrictEqual([
      'initialize', 'session/new', 'session/set_config_option', 'session/prompt'
    ])
    expect(initialRequests[0].params.clientCapabilities).toStrictEqual({})
    expect(initialRequests[1].params.mcpServers).toStrictEqual([])
    expect(initialRequests.find((request) => request.id === 'permission').result.outcome.optionId).toBe('once')

    for (const scenario of ['read-only-config', 'read-only-config-grouped']) {
      const before = (await requests()).length
      const result = await client(scenario).execute({ ...input, readOnly: true }, () => {})
      expect(result.status, result.error).toBe('succeeded')
      const sent = (await requests()).slice(before)
      expect(sent.find((request) => request.params?.configId === 'mode').params).toStrictEqual({ sessionId: 'session-test', configId: 'mode', value: 'plan' })
      expect(sent.some((request) => request.method === 'session/set_mode')).toBe(false)
      expect(sent.find((request) => request.id === 'permission').result.outcome.outcome).toBe('cancelled')
    }
    const beforeRejectedMode = (await requests()).length
    const rejectedMode = await client('read-only-config-rejected').execute({ ...input, readOnly: true }, () => {})
    expect(rejectedMode.status).toBe('failed')
    expect(rejectedMode.error!).toMatch(/Plan mode rejected/)
    expect((await requests()).slice(beforeRejectedMode).some((request) => request.method === 'session/prompt')).toBe(false)

    const unsupportedReadOnly = await client('success').execute({ ...input, readOnly: true }, () => {})
    expect(unsupportedReadOnly.status).toBe('failed')
    expect(unsupportedReadOnly.error!).toMatch(/read-only plan mode/)

    events.length = 0
    const resumed = await client('success').execute({ ...input, resumeSessionId: 'session-test' }, record)
    expect(resumed.output).toBe(expected)
    expect(resumed.changedFiles).toStrictEqual(['/changed.ts'])
    expect(resumed.usage?.costUsd, 'Do not charge session-cumulative cost again on resume').toBe(null)
    expect(!events.some((event) => event.type === 'output' && /history|Old edit/.test(event.event.text))).toBeTruthy()
    expect((await requests()).some((request) => request.method === 'session/load')).toBeTruthy()
    expect(events.filter(event => event.type === 'output').every(event => event.event.issueId === input.issueId)).toBe(true)

    const openrouterModel = 'openrouter/anthropic/claude-sonnet-4-6'
    const openrouter = await client('openrouter').execute({ ...input, model: openrouterModel }, () => {})
    expect(openrouter.status, openrouter.error).toBe('succeeded')
    const modelRequest = (await requests()).findLast((request) => request.method === 'session/set_config_option')
    expect(modelRequest.params.value, 'Keep the OpenRouter route so OpenCode uses that provider\'s credentials').toBe(openrouterModel)

    for (const scenario of ['limited-effort', 'removed-effort', 'success']) {
      events.length = 0
      const requestCount = (await requests()).length
      const limitedEffort = await client(scenario).execute({ ...input, reasoningEffort: 'medium' }, record)
      expect(limitedEffort.status, limitedEffort.error).toBe('failed')
      expect((await requests()).slice(requestCount).some((request) => request.method === 'session/prompt')).toBe(false)
      expect(!events.some((event) => event.type === 'output' && /effort not found: medium/.test(event.event.text)), 'Do not send medium when the selected model does not advertise that effort').toBeTruthy()
      expect(!(await requests()).slice(requestCount).some((request) => request.params?.configId === 'effort'), scenario).toBeTruthy()
      expect(events.some((event) => event.type === 'output' && /does not advertise reasoning effort/.test(event.event.text)), scenario).toBeTruthy()
      if (scenario === 'limited-effort') {
        expect(events.some((event) => event.type === 'output' && /Available efforts: high/.test(event.event.text))).toBeTruthy()
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
      expect(configured.status, configured.error).toBe('succeeded')
      const effortRequests = (await requests()).slice(requestCount).filter((request) => ['effort', 'native-reasoning'].includes(request.params?.configId))
      expect(effortRequests.map((request) => request.params.value)).toStrictEqual([selection.options.reasoningEffort])
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
      expect(nativeEffort.status, nativeEffort.error).toBe(reasoningEffort === 'medium' ? 'failed' : 'succeeded')
      const effortRequests = (await requests()).slice(requestCount).filter((request) => ['effort', 'native-reasoning'].includes(request.params?.configId))
      expect(effortRequests.map((request) => request.params.value), 'Native model efforts must also be checked against the current ACP config').toStrictEqual(reasoningEffort && reasoningEffort !== 'medium' ? [reasoningEffort] : [])
    }

    events.length = 0
    const rejectedEffort = await client('rejected-effort').execute({ ...input, reasoningEffort: 'medium' }, record)
    expect(rejectedEffort.status, 'Rejected explicit effort must prevent prompting').toBe('failed')
    expect(events.some((event) => event.type === 'output' && /OpenCode rejected reasoning effort medium/.test(event.event.text))).toBeTruthy()

    for (const scenario of ['refusal', 'max-tokens', 'rpc-error', 'exit', 'malformed', 'version']) {
      const failed = await client(scenario).execute(input, () => {})
      expect(failed.status, scenario).toBe('failed')
      expect(failed.error, scenario).toBeTruthy()
    }
    if (process.platform !== 'win32') {
      expect((await client('orphan').execute(input, () => {})).status, 'Clean up inherited pipes when the server exits').toBe('failed')
    }
    const unsupported = await client('no-resume').execute({ ...input, resumeSessionId: 'session-test' }, () => {})
    expect(unsupported.error!).toMatch(/does not support loading/)
    const denied = await client('deny-only').execute(input, () => {})
    expect(denied.status, 'Permission cancellation should not break JSON-RPC').toBe('succeeded')
    const startup = await new OpenCodeAcpClient({
      command: process.execPath, args: [fixture, 'startup-hang', transcript], startupTimeoutMs: 30
    }).execute(input, () => {})
    expect(startup.error!).toMatch(/startup timed out/)

    for (const scenario of ['cancel', 'cancel-hang', 'cancel-partial']) {
      const controller = new AbortController()
      const cancellationEvents: TaskEvent[] = []
      const cancelled = await client(scenario).execute({ ...input, signal: controller.signal }, (event) => {
        cancellationEvents.push(event)
        if (event.type === 'output' && event.event.text === (scenario === 'cancel-partial' ? 'Waiting' : 'Waiting\n')) controller.abort()
      })
      expect(cancelled.status, scenario).toBe('cancelled')
      expect(cancelled.output).toBe(scenario === 'cancel-partial' ? 'Waiting' : 'Waiting\n')
      if (scenario === 'cancel-partial') {
        const eventCount = cancellationEvents.length
        await delay(300)
        expect(cancellationEvents.length, 'No timed flush or late update after cancellation').toBe(eventCount)
        expect(cancellationEvents.filter(event => event.type === 'output' && event.event.text === 'Waiting').length).toBe(1)
      }
    }
    expect((await requests()).some((request) => request.method === 'session/cancel')).toBeTruthy()
    const preCancelled = new AbortController()
    preCancelled.abort()
    expect((await client('success').execute({ ...input, signal: preCancelled.signal }, () => {})).status).toBe('cancelled')
    expect((await new OpenCodeAcpClient({ command: '/anvil-missing-opencode' }).execute(input, () => {})).error!).toMatch(/not installed/)
    expect((await client('success').execute({ ...input, cwd: join(directory, 'missing') }, () => {})).status).toBe('failed')
    expect((await client('success').execute({ ...input, cwd: '.' }, () => {})).error!).toMatch(/absolute/)

    const manager = new AgentProcessManager(client('success'))
    onTestCleanup(async () => {
      await manager.close()
      manager.removeAllListeners()
    })
    const forwarded: string[] = []
    for (const name of ['event', 'session', 'usage']) manager.on(name, () => forwarded.push(name))
    const exited = once(manager, 'exit')
    manager.start({ ...input, agent: getAgent('opencode')! })
    expect(manager.isRunning(input.taskId)).toBe(true)
    expect(() => manager.start({ ...input, agent: getAgent('opencode')! })).toThrow(/already running/)
    const [exit] = await exited as [ExitInfo]
    expect(exit.code).toBe(0)
    expect(exit.result?.output).toBe(expected)
    expect(manager.isRunning(input.taskId)).toBe(false)
    expect(['event', 'session', 'usage'].every((name) => forwarded.includes(name))).toBeTruthy()
    const cancellationManager = new AgentProcessManager(client('cancel-hang'))
    onTestCleanup(async () => {
      await cancellationManager.close()
      cancellationManager.removeAllListeners()
    })
    const cancelledExit = once(cancellationManager, 'exit')
    cancellationManager.start({ ...input, agent: getAgent('opencode')! })
    cancellationManager.cancelAll()
    expect(((await cancelledExit) as [ExitInfo])[0].cancelled).toBe(true)
    expect(cancellationManager.isRunning(input.taskId)).toBe(false)

  } finally {
    await Promise.all(clients.map((executor) => executor.close()))
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

test('sends exact inline image data to ACP with server and model capability checks', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anvil-acp-images-'))
  onTestCleanup(() => rm(directory, { recursive: true, force: true }))
  const images = await taskImages()
  const fixture = resolve('tests/fixtures/opencode-acp.cjs')
  for (const scenario of ['image-success', 'image-unsupported', 'image-models-text', 'image-resume', 'image-cancel']) {
    const transcript = join(directory, `${scenario}.jsonl`)
    const client = new OpenCodeAcpClient({
      command: process.execPath, args: [fixture, scenario === 'image-cancel' ? 'cancel' : scenario === 'image-models-text' ? 'image-success' : scenario, transcript],
      modelArgs: [fixture, scenario === 'image-models-text' ? scenario : 'image-models'],
      startupTimeoutMs: 5000, cancelTimeoutMs: 100
    })
    onTestCleanup(() => client.close())
    const controller = new AbortController()
    const events: TaskEvent[] = []
    const result = await client.execute({
      taskId: scenario, cwd: directory, prompt: 'Implement the issue', images, model: 'provider/model', signal: controller.signal,
      ...(scenario === 'image-resume' ? { resumeSessionId: 'session-test' } : {}),
      onStarted: () => { if (scenario === 'image-cancel') controller.abort() }
    }, (event) => events.push(event))
    const sent = (await readFile(transcript, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    const prompt = sent.find((entry) => entry.method === 'session/prompt')
    if (scenario === 'image-unsupported' || scenario === 'image-models-text') {
      expect(result.status).toBe('failed')
      expect(result.error).toMatch(/does not support image prompts|does not advertise image input/)
      expect(prompt).toBeUndefined()
      expect(sent.some((entry) => entry.method === 'session/new')).toBe(false)
    } else {
      expect(result.status, result.error).toBe(scenario === 'image-cancel' ? 'cancelled' : 'succeeded')
      expect(prompt.params.prompt).toEqual([
        { type: 'text', text: 'Implement the issue' },
        ...images.map((image) => ({ type: 'image', mimeType: image.mimeType, data: Buffer.from(image.bytes).toString('base64') }))
      ])
      if (scenario === 'image-resume') expect(sent.some((entry) => entry.method === 'session/load')).toBe(true)
    }
    expect(JSON.stringify(events)).not.toContain(Buffer.from(images[0].bytes).toString('base64'))
    await client.close()
  }
})
