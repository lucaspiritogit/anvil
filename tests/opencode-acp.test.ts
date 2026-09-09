import { testWorkspace } from './workspace-fixture'
import { taskImages } from './task-image-fixture'
import { onTestCleanup } from './test-cleanup'
import { expect, test, vi } from 'vitest'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { openCodeWorkspaceFixture } from './opencode-workspace-fixture'
import { OPEN_CODE_ACP_ARGS, openCodeWorkspaceCommand, requireOpenCodeProjectIsolation } from '../src/main/agents/opencode-workspace'
import { readOpenCodeModelOutput } from '../src/main/agents/opencode-model-output'
import { resolveWorkspaceExecution, type WorkspaceExecutionContext } from '../src/main/agents/workspace-execution'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
    workspace: testWorkspace(),
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
      workspace: testWorkspace(),
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

test('keeps workspace credentials and sessions across concurrent ACP ports and restart', async () => {
  const fixture = await openCodeWorkspaceFixture()
  const occupied = createServer()
  onTestCleanup(() => new Promise<void>((resolve, reject) => {
    if (!occupied.listening) return resolve()
    occupied.close((error) => error ? reject(error) : resolve())
  }))
  await new Promise<void>((resolve, reject) => {
    occupied.once('error', (error: NodeJS.ErrnoException) => error.code === 'EADDRINUSE' ? resolve() : reject(error))
    occupied.listen(4096, '127.0.0.1', resolve)
  })
  const client = (workspace: WorkspaceExecutionContext, args?: string[]): OpenCodeAcpClient => {
    const executor = new OpenCodeAcpClient({ workspace, command: fixture.command, args, startupTimeoutMs: 3_000 })
    onTestCleanup(() => executor.close())
    return executor
  }
  const input = (workspace: WorkspaceExecutionContext, prompt: string): TaskInput => ({ workspace,
    taskId: prompt, cwd: fixture.project, prompt, model: `openai/${workspace.workspaceId}-key` })
  for (const workspace of [fixture.work, fixture.personal]) {
    const launch = openCodeWorkspaceCommand(workspace, ['auth', 'login', `${workspace.workspaceId}-key`])
    await readOpenCodeModelOutput(fixture.command, launch.args, launch.cwd, undefined, launch.environment)
  }
  const work = client(fixture.work)
  const personal = client(fixture.personal)
  const [workResult, personalResult] = await Promise.all([
    work.execute({ ...input(fixture.work, 'work'), images: await taskImages() }, () => {}),
    personal.execute(input(fixture.personal, 'personal'), () => {})
  ])
  expect(workResult.status, workResult.error).toBe('succeeded')
  expect(personalResult.status, personalResult.error).toBe('succeeded')
  expect(workResult.output).toBe('work-key')
  expect(personalResult.output).toBe('personal-key')
  const workListener = (await fixture.entries(fixture.work)).find((entry) => entry.event === 'listening')!
  const personalListener = (await fixture.entries(fixture.personal)).find((entry) => entry.event === 'listening')!
  expect(workListener.port).not.toBe(personalListener.port)
  expect(workListener.port).not.toBe(4096)
  expect(personalListener.port).not.toBe(4096)
  expect(workListener.hostname).toBe('127.0.0.1')
  expect(personalListener.hostname).toBe('127.0.0.1')
  await work.close()
  await assertPortReleased(workListener.port!)
  const restarted = client(fixture.work)
  const resumed = await restarted.execute({ ...input(fixture.work, 'resume'), resumeSessionId: workResult.sessionId }, () => {})
  expect(resumed.status, resumed.error).toBe('succeeded')
  expect(resumed.sessionId).toBe(workResult.sessionId)
  const crossed = await personal.execute({ ...input(fixture.personal, 'crossed'), resumeSessionId: workResult.sessionId }, () => {})
  expect(crossed.status).toBe('failed')
  expect(crossed.error).toContain('Session not found in workspace')
  expect((await restarted.execute(input(fixture.work, 'crash'), () => {})).status).toBe('failed')
  expect((await restarted.execute({ ...input(fixture.work, 'recover'), resumeSessionId: workResult.sessionId }, () => {})).status).toBe('succeeded')
  await restarted.close()
  await personal.close()
  for (const workspace of [fixture.work, fixture.personal]) {
    for (const entry of (await fixture.entries(workspace)).filter((entry) => entry.event === 'listening')) {
      await assertPortReleased(entry.port!)
    }
  }
  await fixture.assertGlobalUnchanged()
})

async function assertPortReleased(port: number): Promise<void> {
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
  } finally {
    if (server.listening) await new Promise<void>((resolve) => { server.close(() => resolve()) })
  }
}

test('cancels or fails workspace ACP startup and releases the child port', async () => {
  const fixture = await openCodeWorkspaceFixture()
  for (const action of ['cancel', 'cancel-peers', 'timeout', 'shutdown'] as const) {
    const workspace = resolveWorkspaceExecution({ getWorkspaceDirectory: (id) => join(fixture.directory, id) }, action)
    const client = new OpenCodeAcpClient({ workspace, command: fixture.command,
      args: [...OPEN_CODE_ACP_ARGS, '--hang-startup'], startupTimeoutMs: action === 'timeout' ? 300 : 5_000 })
    onTestCleanup(() => client.close())
    const controller = new AbortController()
    const task: TaskInput = { workspace, taskId: action, prompt: action, cwd: fixture.project, model: 'openai/model', signal: controller.signal }
    const result = client.execute(task, () => {})
    const peer = action === 'cancel-peers' ? client.execute({ ...task, taskId: 'peer' }, () => {}) : undefined
    let port: number | undefined
    await vi.waitFor(async () => {
      port = (await fixture.entries(workspace)).find((entry) => entry.event === 'listening')?.port
      expect(port).toBeTypeOf('number')
    })
    if (action.startsWith('cancel')) controller.abort()
    if (action === 'shutdown') await client.close()
    expect((await result).status).toBe(action.startsWith('cancel') ? 'cancelled' : 'failed')
    if (peer) expect((await peer).status).toBe('cancelled')
    if (action.startsWith('cancel')) await assertPortReleased(port!)
    await client.close()
    await assertPortReleased(port!)
  }
  await fixture.assertGlobalUnchanged()
})

test('rejects project credential sources and unsupported providers without losing repository instructions', async () => {
  const fixture = await openCodeWorkspaceFixture()
  const client = new OpenCodeAcpClient({ workspace: fixture.work, command: fixture.command })
  onTestCleanup(() => client.close())
  const input: TaskInput = { workspace: fixture.work, taskId: 'policy', prompt: 'test', cwd: fixture.project, model: 'openai/model' }
  for (const name of ['.env', '.env.local', 'opencode.json', 'opencode.jsonc', '.opencode/opencode.json']) {
    const path = join(fixture.project, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, name.includes('env') ? 'OPENAI_API_KEY=project-secret' : '{"provider":{"openai":{"options":{"apiKey":"project-secret"}}}}')
    const result = await client.execute(input, () => {})
    expect(result.status).toBe('failed')
    expect(result.error).toContain('OpenCode workspace isolation cannot be guaranteed')
    expect(result.error).not.toContain('project-secret')
    await rm(path)
  }
  await writeFile(join(fixture.project, '.env.example'), 'OPENAI_API_KEY=example')
  expect(() => requireOpenCodeProjectIsolation(fixture.project)).not.toThrow()
  const unsupported = await client.execute({ ...input, model: 'amazon-bedrock/model' }, () => {})
  expect(unsupported.error).toContain('credential chains have not been verified')
  const crossed = await client.execute({ ...input, workspace: fixture.personal }, () => {})
  expect(crossed.error).toContain('different workspace')
  expect(existsSync(join(fixture.work.home, 'opencode.jsonl'))).toBe(false)
  await fixture.assertGlobalUnchanged()
})

test('cancels the version probe before ACP startup and permits a later retry', async () => {
  const fixture = await openCodeWorkspaceFixture()
  const command = join(fixture.directory, process.platform === 'win32' ? 'slow-version.cmd' : 'slow-version')
  const script = join(fixture.directory, 'slow-version.cjs')
  const marker = join(fixture.work.home, 'version-started')
  await writeFile(script, `
const fs = require('node:fs')
if (process.argv.includes('--version') && !fs.existsSync(${JSON.stringify(marker)})) {
  fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid))
  setInterval(() => {}, 1000)
} else {
  require(${JSON.stringify(resolve('tests/fixtures/opencode-workspace.cjs'))})
}
`)
  await writeFile(command, process.platform === 'win32'
    ? `@echo off\n"${process.execPath}" "${script}" %*\n`
    : `#!${process.execPath}\nrequire(${JSON.stringify(script)})\n`, { mode: 0o755 })
  const client = new OpenCodeAcpClient({ workspace: fixture.work, command })
  onTestCleanup(() => client.close())
  const controller = new AbortController()
  const input: TaskInput = { workspace: fixture.work, taskId: 'version-cancel', prompt: 'test', cwd: fixture.project, model: 'openai/model' }
  const result = client.execute({ ...input, signal: controller.signal }, () => {})
  await vi.waitFor(() => expect(existsSync(marker)).toBe(true))
  const pid = Number(await readFile(marker, 'utf8'))
  controller.abort()
  expect((await result).status).toBe('cancelled')
  expect(() => process.kill(pid, 0)).toThrow()
  expect(existsSync(join(fixture.work.home, 'opencode.jsonl'))).toBe(false)
  expect((await client.execute(input, () => {})).status).toBe('succeeded')
  await fixture.assertGlobalUnchanged()
})
