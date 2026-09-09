import { testWorkspace } from './workspace-fixture'
import { taskImages } from './task-image-fixture'
import { onTestCleanup } from './test-cleanup'
import { expect, test, vi } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { CodexAppServerClient } from '../src/main/agents/codex-app-server'
import { AgentProcessManager, type ExitInfo } from '../src/main/agents/process-manager'
import { getAgent } from '../src/main/agents/registry'
import type { TaskEvent, TaskInput } from '../src/main/agents/agent-executor'
import { codexAdapter } from '../src/main/agents/adapters'
import { resolveWorkspaceExecution, type WorkspaceExecutionContext } from '../src/main/agents/workspace-execution'

interface ProfileLaunch {
  pid: number
  home: string
  codexHome: string
  credentialStore: string
  account: string | null
  inheritedCredentials: string[]
}

async function profileFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'anvil-codex-profiles-'))
  onTestCleanup(() => rm(directory, { recursive: true, force: true }))
  const profile = (id: string): WorkspaceExecutionContext => resolveWorkspaceExecution({
    getWorkspaceDirectory: (workspaceId) => join(directory, workspaceId)
  }, id)
  let nextClient = 0
  const client = (workspace: WorkspaceExecutionContext, scenario = 'profile-success') => {
    const transcript = join(directory, `client-${++nextClient}.jsonl`)
    const args = [resolve('tests/fixtures/codex-app-server.cjs'), scenario, transcript]
    const executor = new CodexAppServerClient({ workspace, command: process.execPath, args, requestTimeoutMs: 2000 })
    onTestCleanup(() => executor.close())
    const launches = async (): Promise<ProfileLaunch[]> => (await readFile(transcript + '.profiles', 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    const requests = async (): Promise<Array<{ method: string; params: Record<string, unknown> }>> =>
      (await readFile(transcript, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    return { executor, args, launches, requests }
  }
  const input = (workspace: WorkspaceExecutionContext): TaskInput => ({
    workspace, taskId: workspace.workspaceId, cwd: directory, prompt: 'Implement the issue', model: 'test-model'
  })
  const authenticate = (workspace: WorkspaceExecutionContext, account: string) =>
    writeFile(join(workspace.codexHome, 'auth.json'), JSON.stringify({ fixtureAccount: account }))
  return { directory, profile, client, input, authenticate }
}

test('isolates simultaneous Codex tasks, accounts and model discovery without touching global files', async () => {
  const fixture = await profileFixture()
  const globalHome = join(fixture.directory, 'global-home')
  const globalCodex = join(globalHome, '.codex')
  await mkdir(join(globalCodex, 'sessions'), { recursive: true })
  const sentinels = [join(globalCodex, 'auth.json'), join(globalCodex, 'config.toml'), join(globalCodex, 'sessions', 'global-session.jsonl')]
  for (const path of sentinels) await writeFile(path, 'global sentinel: ' + path)
  const originalStats = await Promise.all(sentinels.map((path) => lstat(path)))
  vi.stubEnv('HOME', globalHome)
  vi.stubEnv('CODEX_HOME', globalCodex)
  for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_ACCESS_TOKEN', 'CODEX_ACCESS_TOKEN', 'CODEX_AUTH_JSON', 'CODEX_THREAD_ID']) vi.stubEnv(key, 'synthetic-inherited-value')
  onTestCleanup(() => { vi.unstubAllEnvs() })
  const work = fixture.profile('work')
  const personal = fixture.profile('personal')
  await fixture.authenticate(work, 'work-account')
  await fixture.authenticate(personal, 'personal-account')
  const workClient = fixture.client(work)
  const personalClient = fixture.client(personal)
  const accounts = await Promise.all([workClient.executor.readAccount(), personalClient.executor.readAccount()])
  expect(accounts.map((result) => result.account)).toEqual([
    { type: 'chatgpt', email: 'work-account@example.invalid', planType: 'plus' },
    { type: 'chatgpt', email: 'personal-account@example.invalid', planType: 'plus' }
  ])
  const results = await Promise.all([
    workClient.executor.execute(fixture.input(work), () => {}),
    personalClient.executor.execute(fixture.input(personal), () => {})
  ])
  expect(results.map((result) => result.status)).toEqual(['succeeded', 'succeeded'])
  expect(results[0].sessionId).not.toBe(results[1].sessionId)
  const launches = [...await workClient.launches(), ...await personalClient.launches()]
  expect(new Set(launches.map((launch) => launch.pid)).size).toBe(2)
  for (const [index, workspace] of [work, personal].entries()) {
    expect(launches[index]).toMatchObject({ home: workspace.home, codexHome: workspace.codexHome, credentialStore: 'file', inheritedCredentials: [] })
    expect((await lstat(join(workspace.codexHome, 'auth.json'))).isSymbolicLink()).toBe(false)
    expect(await readFile(join(workspace.codexHome, 'fixture-sessions.json'), 'utf8')).not.toContain(results[1 - index].sessionId)
    const discovery = fixture.client(workspace)
    const catalogue = await codexAdapter.listModels({ ...getAgent('codex')!, command: process.execPath, args: discovery.args }, workspace)
    expect(catalogue.models).toEqual([launches[index].account])
    const [discoveryLaunch] = await discovery.launches()
    expect(discoveryLaunch).toMatchObject({ codexHome: workspace.codexHome, account: launches[index].account, credentialStore: 'file', inheritedCredentials: [] })
    expect(discoveryLaunch.pid).not.toBe(launches[index].pid)
    expect(() => process.kill(discoveryLaunch.pid, 0)).toThrow()
    expect((await discovery.requests()).some((entry) => entry.method === 'thread/start')).toBe(false)
  }
  const wrongWorkspace = await workClient.executor.execute(fixture.input(personal), () => {})
  expect(wrongWorkspace.error).toMatch(/different workspace/)
  expect((await workClient.requests()).filter((entry) => entry.method === 'thread/start')).toHaveLength(1)
  await workClient.executor.close()
  expect(() => process.kill(launches[0].pid, 0)).toThrow()
  expect((await personalClient.executor.readAccount()).account).toEqual(accounts[1].account)
  await personalClient.executor.close()
  expect(() => process.kill(launches[1].pid, 0)).toThrow()
  for (const [index, path] of sentinels.entries()) {
    expect(await readFile(path, 'utf8')).toBe('global sentinel: ' + path)
    const stat = await lstat(path)
    expect(stat.ino).toBe(originalStats[index].ino)
    expect(stat.mtimeMs).toBe(originalStats[index].mtimeMs)
  }
})

test('restarts Codex in its original profile and resumes only that profile’s saved thread', async () => {
  const fixture = await profileFixture()
  const work = fixture.profile('work')
  await fixture.authenticate(work, 'work-account')
  const client = fixture.client(work, 'profile-restart')
  const interrupted = await client.executor.execute(fixture.input(work), () => {})
  expect(interrupted.status).toBe('failed')
  expect(interrupted.sessionId).toMatch(/^work-account-/)
  const resumed = await client.executor.execute({ ...fixture.input(work), resumeSessionId: interrupted.sessionId }, () => {})
  expect(resumed.status, resumed.error).toBe('succeeded')
  expect(resumed.sessionId).toBe(interrupted.sessionId)
  const launches = await client.launches()
  expect(launches).toHaveLength(2)
  expect(launches[0].pid).not.toBe(launches[1].pid)
  for (const launch of launches) expect(launch).toMatchObject({ codexHome: work.codexHome, account: 'work-account', credentialStore: 'file', inheritedCredentials: [] })
  const requests = await client.requests()
  expect(requests.filter((entry) => entry.method === 'config/read')).toHaveLength(2)
  expect(requests.filter((entry) => entry.method === 'thread/resume').map((entry) => entry.params.threadId)).toEqual([interrupted.sessionId])
  const personal = fixture.profile('personal')
  await fixture.authenticate(personal, 'personal-account')
  const personalClient = fixture.client(personal)
  const unavailable = await personalClient.executor.execute({ ...fixture.input(personal), resumeSessionId: interrupted.sessionId }, () => {})
  expect(unavailable.error).toBe(`no rollout found for thread id ${interrupted.sessionId}`)
  expect((await personalClient.requests()).some((entry) => entry.method === 'thread/start')).toBe(false)
})

test('requires workspace authentication before migrated-session recovery or model discovery', async () => {
  const fixture = await profileFixture()
  const workspace = fixture.profile('migrated')
  const client = fixture.client(workspace, 'profile-recovery')
  const input = { ...fixture.input(workspace), resumeSessionId: 'global-session', resumeFallbackPrompt: 'Recover the saved plan and branch' }
  expect(await client.executor.readAccount()).toEqual({ account: null, requiresOpenaiAuth: true })
  const unauthenticated = await client.executor.execute(input, () => {})
  expect(unauthenticated.error).toContain(`CODEX_HOME=${workspace.codexHome}`)
  await expect(client.executor.listModels(fixture.directory)).rejects.toThrow(/not authenticated/)
  expect((await client.requests()).some((entry) => ['thread/resume', 'thread/start', 'model/list'].includes(entry.method))).toBe(false)
  await fixture.authenticate(workspace, 'new-work-account')
  const events: TaskEvent[] = []
  const recovered = await client.executor.execute(input, (event) => events.push(event))
  expect(recovered.status, recovered.error).toBe('succeeded')
  expect(recovered.sessionId).toMatch(/^new-work-account-/)
  const requests = await client.requests()
  expect(requests.filter((entry) => entry.method.startsWith('thread/')).map((entry) => entry.method)).toEqual(['thread/resume', 'thread/start'])
  expect(requests.find((entry) => entry.method === 'turn/start')?.params.input).toEqual([{ type: 'text', text: input.resumeFallbackPrompt, text_elements: [] }])
  expect(events.some((event) => event.type === 'output' && event.event.text.includes('previous conversation history was not restored'))).toBe(true)
  expect((await client.launches()).map((launch) => launch.account)).toEqual([null, null, null, 'new-work-account'])
  expect(await client.executor.listModels(fixture.directory)).toEqual({ models: ['new-work-account'], reasoningByModel: { 'new-work-account': { options: [], default: 'none' } } })
})

test('rejects unsupported or enforced credential stores before account access and cleans up failed servers', async () => {
  const fixture = await profileFixture()
  const workspace = fixture.profile('restricted')
  for (const scenario of ['profile-config-unsupported', 'profile-config-rejected', 'profile-keyring', 'profile-config-missing']) {
    const client = fixture.client(workspace, scenario)
    await expect(client.executor.readAccount()).rejects.toThrow(/requires cli_auth_credentials_store="file".*Update Codex.*administrator/)
    expect((await client.requests()).map((entry) => entry.method)).toEqual(['initialize', 'initialized', 'config/read'])
    await client.executor.close()
    for (const launch of await client.launches()) expect(() => process.kill(launch.pid, 0)).toThrow()
  }
  const startup = fixture.client(workspace, 'profile-startup-rejected')
  const events: TaskEvent[] = []
  const result = await startup.executor.execute(fixture.input(workspace), (event) => events.push(event))
  expect(result.error).toMatch(/requires cli_auth_credentials_store="file".*administrator/)
  expect(events.some((event) => event.type === 'output' && event.event.stream === 'stderr' && event.event.text.includes('rejected by administrator policy'))).toBe(true)
  await startup.executor.close()
  for (const launch of await startup.launches()) expect(() => process.kill(launch.pid, 0)).toThrow()
})

test('handles Codex threads, turns, permissions, steering and recovery', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anvil-codex-server-'))
  onTestCleanup(() => rm(directory, { recursive: true, force: true }))
  const fixture = resolve('tests/fixtures/codex-app-server.cjs')
  const transcript = join(directory, 'requests.jsonl')
  const input: TaskInput = {
    workspace: testWorkspace(),
    taskId: 'task-test', issueId: 'issue-test', prompt: 'Implement the issue',
    cwd: directory, model: 'test-model'
  }
  const clients: CodexAppServerClient[] = []
  const client = (scenario: string): CodexAppServerClient => {
    const executor = new CodexAppServerClient({ workspace: testWorkspace(),
      command: process.execPath, args: [fixture, scenario, transcript], requestTimeoutMs: 5_000,
      cancelTimeoutMs: scenario === 'cancel-before-ack' ? 500 : 30
    })
    onTestCleanup(() => executor.close())
    clients.push(executor)
    return executor
  }
  const events: TaskEvent[] = []
  const record = (event: TaskEvent): void => { events.push(event) }
  const requests = async (): Promise<any[]> => (await readFile(transcript, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
  const outputEvents = () => events.filter((event) => event.type === 'output').map((event) => event.event)
  const expected = 'Done ✓\nCompleted issue-test through vl. Tests passed.'
  try {
    const discoveryClient = client('models')
    expect(await discoveryClient.listModels(directory)).toStrictEqual({
      models: ['reasoner', 'plain'],
      reasoningByModel: {
        reasoner: { options: [{ id: 'native-max', label: 'Maximum reasoning' }, { id: 'low', label: 'Fast reasoning' }], default: 'native-max' },
        plain: { options: [], default: 'none' }
      }
    })
    const discoveredRequests = await requests()
    expect(discoveredRequests.filter((entry) => entry.method === 'model/list').map((entry) => entry.params)).toStrictEqual([{}, { cursor: 'page-2' }])
    expect(discoveredRequests.some((entry) => entry.method === 'thread/start')).toBe(false)
    const sharedExecution = await discoveryClient.execute(input, () => {})
    expect(sharedExecution.status).toBe('succeeded')
    expect((await requests()).filter((entry) => entry.method === 'initialize').length, 'Discovery and execution reuse the server').toBe(1)
    await discoveryClient.close()
    expect(await client('models-empty').listModels(directory)).toStrictEqual({ models: [], reasoningByModel: {} })
    await expect(client('models-error').listModels(directory)).rejects.toThrow(/Discovery unavailable/)
    await expect(client('models-malformed').listModels(directory)).rejects.toThrow(/string|reasoning/)
    await expect(client('models-cycle').listModels(directory)).rejects.toThrow(/pagination cursor/)
    const hangingDiscovery = client('models-hang')
    const pendingDiscovery = hangingDiscovery.listModels(directory)
    const rejectedDiscovery = expect(pendingDiscovery).rejects.toThrow(/closed|shutting down/)
    await hangingDiscovery.close()
    await rejectedDiscovery
    await writeFile(transcript, '')
    const result = await client('success').execute(input, record)
    expect(result.status, result.error).toBe('succeeded')
    expect(result.sessionId).toBe('thread-test')
    expect(result.issueId).toBe('issue-test')
    expect(result.output).toBe(expected)
    expect(result.changedFiles).toStrictEqual(['/changed.ts', '/renamed.ts'])
    expect(result.usage).toStrictEqual({ inputTokens: 40, outputTokens: 20, cachedTokens: 20, totalTokens: 60, costUsd: null })
    expect(outputEvents().filter((event) => event.category === 'message').map((event) => event.text)).toStrictEqual([expected])
    expect(outputEvents().filter((event) => event.category === 'thinking').map((event) => event.text)).toStrictEqual(['Thinking\n'])
    expect(outputEvents().filter((event) => event.text === 'Tests passed\n').length).toBe(1)
    expect(outputEvents().some((event) => event.stream === 'stderr' && event.text === 'trailing diagnostic')).toBeTruthy()
    expect(outputEvents().every((event) => event.id && event.ts && event.taskId === input.taskId && event.issueId === input.issueId)).toBeTruthy()
    expect(events.filter((event) => event.type === 'session').length).toBe(1)
    const initial = await requests()
    expect(initial.map((request) => request.method)).toStrictEqual(['initialize', 'initialized', 'config/read', 'account/read', 'thread/start', 'turn/start'])
    expect(initial.every((request) => !('jsonrpc' in request))).toBeTruthy()
    expect(initial[0].params).toStrictEqual({ clientInfo: { name: 'anvil', title: 'Anvil', version: '0.1.0' } })
    expect(initial[4].params.approvalPolicy).toBe('never')
    expect(initial[4].params.sandbox).toBe('danger-full-access')
    expect(initial[4].params.cwd).toBe(directory)
    expect(initial[4].params.model).toBe('test-model')
    expect(initial[4].params.config, 'Anvil tasks use project memory, not unrelated Codex personal context').toStrictEqual({
      'memories.use_memories': false,
      'memories.generate_memories': false,
      'features.recommended_plugins': false,
      tool_output_token_limit: 3000,
      'shell_environment_policy.set.PATH': process.env.PATH ?? ''
    })
    expect(initial[5].params.input, 'Only the task prompt is sent, not the persisted event log').toStrictEqual([{ type: 'text', text: input.prompt, text_elements: [] }])
    expect(initial[5].params.cwd).toBe(directory)
    expect(initial[5].params.sandboxPolicy, 'Browser validation must run without the Codex OS sandbox').toStrictEqual({
      type: 'dangerFullAccess'
    })

    for (const { resumeSessionId, reasoningEffort } of [
      { resumeSessionId: undefined, reasoningEffort: 'native-max' },
      { resumeSessionId: 'thread-test', reasoningEffort: 'low' },
      { resumeSessionId: undefined, reasoningEffort: undefined },
      { resumeSessionId: 'thread-test', reasoningEffort: undefined }
    ]) {
      await writeFile(transcript, '')
      const configured = await client('success').execute({ ...input, model: 'reasoner', reasoningEffort, resumeSessionId }, () => {})
      expect(configured.status, configured.error).toBe('succeeded')
      const calls = await requests()
      const thread = calls.find((entry) => entry.method === (resumeSessionId ? 'thread/resume' : 'thread/start'))
      expect(thread.params.config.model_reasoning_effort).toBe(reasoningEffort)
      expect('model_reasoning_effort' in thread.params.config).toBe(reasoningEffort !== undefined)
      expect(thread.params.threadId).toBe(resumeSessionId)
      expect('reasoningEffort' in thread.params, 'Only protocol settings go on the wire').toBe(false)
      expect(calls.some((entry) => entry.method === 'model/list')).toBe(reasoningEffort !== undefined)
    }
    for (const model of ['reasoner', 'plain', undefined]) {
      await writeFile(transcript, '')
      const invalid = await client('success').execute({ ...input, model, reasoningEffort: 'removed-option', resumeSessionId: 'thread-test' }, () => {})
      expect(invalid.status).toBe('failed')
      expect(invalid.error!).toMatch(/does not advertise reasoning effort removed-option/)
      expect((await requests()).some((entry) => entry.method.startsWith('thread/') || entry.method === 'turn/start')).toBe(false)
    }
    await writeFile(transcript, '')
    const rejected = await client('rejected-effort').execute({ ...input, model: 'reasoner', reasoningEffort: 'native-max' }, () => {})
    expect(rejected.status).toBe('failed')
    expect(rejected.error, 'Preserve the actual RPC error without blaming reasoning settings').toBe('Effort rejected by backend')
    expect((await requests()).some((entry) => entry.method === 'turn/start')).toBe(false)

    await writeFile(transcript, '')
    const recoveryEvents: TaskEvent[] = []
    const recoveryInput = {
      ...input, model: 'reasoner', reasoningEffort: 'low', resumeSessionId: 'missing-thread',
      resumeFallbackPrompt: 'Recover the saved plan and branch'
    }
    const recovered = await client('missing-rollout').execute(recoveryInput, (event) => recoveryEvents.push(event))
    expect(recovered.status, recovered.error).toBe('succeeded')
    expect(recoveryEvents.filter(event => event.type === 'output').every(event => event.event.issueId === input.issueId)).toBe(true)
    expect(recovered.sessionId).toBe('thread-test')
    expect(recovered.usage, 'A replacement thread counts usage from zero').toStrictEqual(result.usage)
    const recoveryCalls = await requests()
    expect(recoveryCalls.filter((entry) => entry.method.startsWith('thread/')).map((entry) => entry.method)).toStrictEqual(['thread/resume', 'thread/start'])
    expect(recoveryCalls.find((entry) => entry.method === 'thread/start').params.config.model_reasoning_effort).toBe('low')
    expect(recoveryCalls.find((entry) => entry.method === 'turn/start').params.input[0].text).toBe(recoveryInput.resumeFallbackPrompt)
    expect(recoveryEvents.some((event) => event.type === 'output' && /missing-thread.*new session/.test(event.event.text))).toBeTruthy()

    await writeFile(transcript, '')
    const missing = await client('missing-rollout').execute({ ...input, model: 'reasoner', reasoningEffort: 'low', resumeSessionId: 'missing-thread' }, () => {})
    expect(missing.status, 'Do not silently lose history without a recovery prompt').toBe('failed')
    expect(missing.error!).toMatch(/no rollout found/)
    expect(missing.error!).not.toMatch(/reasoning effort/)
    expect((await requests()).some((entry) => entry.method === 'thread/start')).toBe(false)

    await writeFile(transcript, '')
    const rejectedResume = await client('rejected-effort').execute(recoveryInput, () => {})
    expect(rejectedResume.status).toBe('failed')
    expect((await requests()).some((entry) => entry.method === 'thread/start'), 'Other resume errors must not start a new session').toBe(false)

    const removedDirectory = join(directory, 'removed-worktree')
    await mkdir(removedDirectory)
    const reusable = client('success')
    expect((await reusable.execute({ ...input, cwd: removedDirectory }, () => {})).status).toBe('succeeded')
    await rm(removedDirectory, { recursive: true })
    await mkdir(removedDirectory)
    const reopened = await reusable.execute({ ...input, cwd: removedDirectory, resumeSessionId: 'thread-test' }, () => {})
    expect(reopened.status, `The shared server must survive worktree cleanup: ${reopened.error}`).toBe('succeeded')

    await writeFile(transcript, '')
    events.length = 0
    const resumed = await client('success').execute({ ...input, resumeSessionId: 'thread-test' }, record)
    expect(resumed.output).toBe(expected)
    expect(resumed.usage, 'Subtract a pre-turn baseline, not last or the full thread history').toStrictEqual(result.usage)
    expect(!outputEvents().some((event) => /old history|old issue/.test(event.text))).toBeTruthy()
    const resumeRequest = (await requests()).find((request) => request.method === 'thread/resume')
    expect(resumeRequest.params.threadId).toBe('thread-test')
    expect(resumeRequest.params.sandbox).toBe('danger-full-access')
    expect(resumeRequest.params.approvalPolicy).toBe('never')
    expect(resumeRequest.params.config).toStrictEqual(initial[4].params.config)
    const unknownUsage = await client('no-baseline').execute({ ...input, resumeSessionId: 'thread-test' }, () => {})
    expect(unknownUsage.usage, 'Never charge resumed history when Codex supplies no baseline').toBe(undefined)

    for (const scenario of ['snapshot-only', 'early-events', 'revision']) {
      const final = await client(scenario).execute(input, () => {})
      expect(final.status, `${scenario}: ${final.error}`).toBe('succeeded')
      expect(final.output, scenario).toBe(expected)
    }
    for (const scenario of ['failure', 'invalid-status', 'bad-thread', 'rpc-error', 'exit', 'malformed', 'eof']) {
      const failed = await client(scenario).execute(input, () => {})
      expect(failed.status, scenario).toBe('failed')
      expect(failed.error, scenario).toBeTruthy()
      if (scenario === 'failure') expect(failed.error!).toMatch(/Provider rejected/)
    }
    if (process.platform !== 'win32') expect((await client('orphan').execute(input, () => {})).status).toBe('failed')
    expect((await client('interrupted').execute(input, () => {})).status).toBe('cancelled')
    const startup = await new CodexAppServerClient({ workspace: testWorkspace(),
      command: process.execPath, args: [fixture, 'startup-hang', transcript], requestTimeoutMs: 30
    }).execute(input, () => {})
    expect(startup.error!).toMatch(/initialize request timed out/)

    expect((await client('permissions').execute(input, () => {})).status).toBe('succeeded')
    const permissionResponses = (await requests()).filter((request) => !request.method && request.id !== undefined)
    expect(permissionResponses.find((response) => response.id === 1).result.decision).toBe('accept')
    expect(permissionResponses.find((response) => response.id === 'file').result.decision).toBe('accept')
    expect(permissionResponses.find((response) => response.id === 'permissions').result).toStrictEqual({ permissions: { network: { enabled: true } }, scope: 'turn' })
    for (const requestId of ['stale-command', 'foreign-command']) {
      expect(permissionResponses.find((response) => response.id === requestId).result.decision).toBe('cancel')
    }
    for (const requestId of ['stale-permissions', 'foreign-permissions']) {
      expect(permissionResponses.find((response) => response.id === requestId).result).toStrictEqual({ permissions: {}, scope: 'turn' })
    }
    expect(permissionResponses.find((response) => response.id === 'elicitation').result).toStrictEqual({ action: 'cancel', content: null })
    expect(permissionResponses.find((response) => response.id === 'input').result).toStrictEqual({ answers: {} })
    expect(permissionResponses.find((response) => response.id === 'unknown').error.code).toBe(-32601)

    const beforeReadOnly = (await requests()).length
    const readOnly = await client('read-only').execute({ ...input, readOnly: true }, () => {})
    expect(readOnly.status, readOnly.error).toBe('succeeded')
    const readOnlyRequests = (await requests()).slice(beforeReadOnly)
    expect(readOnlyRequests.find((request) => request.method === 'thread/start').params.sandbox).toBe('read-only')
    expect(readOnlyRequests.find((request) => request.method === 'turn/start').params.sandboxPolicy).toStrictEqual({ type: 'readOnly' })
    expect(readOnlyRequests.find((request) => request.id === 'file').result.decision).toBe('cancel')
    expect(readOnlyRequests.find((request) => request.id === 'permissions').result.permissions).toStrictEqual({})

    for (const scenario of ['steer', 'steer-error']) {
      const executor = client(scenario)
      let ready!: () => void
      const started = new Promise<void>((resolve) => { ready = resolve })
      const execution = executor.execute(input, (event) => {
        if (event.type === 'output' && event.event.text === 'Waiting for steering\n') ready()
      })
      await started
      const steering = { taskId: input.taskId, sessionId: 'thread-test', message: 'Adjust validation' }
      await expect(executor.steer({ ...steering, taskId: 'other-task' })).rejects.toThrow(/no active/)
      await expect(executor.steer({ ...steering, sessionId: 'old-thread' })).rejects.toThrow(/session changed/)
      await expect(executor.steer({ ...steering, message: ' ' })).rejects.toThrow(/needs some text/)
      if (scenario === 'steer-error') await expect(executor.steer(steering)).rejects.toThrow(/Steering not permitted/)
      await executor.steer(steering)
      expect((await execution).status).toBe('succeeded')
      await expect(executor.steer(steering)).rejects.toThrow(/no active/)
    }
    const steeringRequests = (await requests()).filter((request) => request.method === 'turn/steer')
    expect(steeringRequests.length).toBe(3)
    expect(steeringRequests[0].params).toStrictEqual({
      threadId: 'thread-test', expectedTurnId: 'turn-test',
      input: [{ type: 'text', text: 'Adjust validation', text_elements: [] }]
    })

    const steeringManager = new AgentProcessManager(undefined, client('steer'))
    onTestCleanup(async () => {
      await steeringManager.close()
      steeringManager.removeAllListeners()
    })
    let managerReady!: () => void
    const managerStarted = new Promise<void>((resolve) => { managerReady = resolve })
    steeringManager.on('event', (event) => { if (event.text === 'Waiting for steering\n') managerReady() })
    const steeringExit = once(steeringManager, 'exit')
    steeringManager.start({ ...input, agent: getAgent('codex')! })
    await managerStarted
    await steeringManager.steer({ taskId: input.taskId, sessionId: 'thread-test', message: 'Adjust validation' })
    expect(((await steeringExit) as [ExitInfo])[0].code).toBe(0)
    await expect(steeringManager.steer({ taskId: input.taskId, sessionId: 'thread-test', message: 'Adjust validation' })).rejects.toThrow(/no active/)

    for (const scenario of ['cancel', 'cancel-hang', 'cancel-before-ack']) {
      const controller = new AbortController()
      const cancelled = await client(scenario).execute({ ...input, signal: controller.signal }, (event) => {
        if (event.type === 'output' && ['Waiting\n', 'Abort before acknowledgement'].includes(event.event.text)) controller.abort()
      })
      expect(cancelled.status, scenario).toBe('cancelled')
    }
    expect((await requests()).some((request) => request.method === 'turn/interrupt')).toBeTruthy()
    const controller = new AbortController()
    controller.abort()
    expect((await client('success').execute({ ...input, signal: controller.signal }, () => {})).status).toBe('cancelled')
    const duringStartup = new AbortController()
    const pendingStartup = client('startup-hang').execute({ ...input, signal: duringStartup.signal }, () => {})
    duringStartup.abort()
    expect((await pendingStartup).status).toBe('cancelled')
    expect((await new CodexAppServerClient({ workspace: testWorkspace(), command: '/missing-codex' }).execute(input, () => {})).error!).toMatch(/not installed/)
    expect((await client('success').execute({ ...input, cwd: join(directory, 'missing') }, () => {})).status).toBe('failed')
    expect((await client('success').execute({ ...input, cwd: '.' }, () => {})).error!).toMatch(/absolute/)

    const resumedManager = new AgentProcessManager(undefined, client('success'))
    onTestCleanup(async () => {
      await resumedManager.close()
      resumedManager.removeAllListeners()
    })
    const startupExits: ExitInfo[] = []
    resumedManager.on('exit', (info) => startupExits.push(info))
    const cancelledStartup = expect(resumedManager.startResumed({ ...input, agent: getAgent('codex')! })).rejects.toThrow()
    resumedManager.cancel(input.taskId)
    await cancelledStartup
    expect(startupExits.length, 'Rejected startup is rolled back by the caller, without task finalization').toBe(0)
    expect(resumedManager.isRunning(input.taskId)).toBe(false)
    const resumedExit = once(resumedManager, 'exit')
    await resumedManager.startResumed({ ...input, agent: getAgent('codex')! })
    expect(((await resumedExit) as [ExitInfo])[0].cancelled, 'A cancelled startup must not cancel the next successful turn').toBe(false)

    const beforeGuarded = (await requests()).length
    let checks = 0
    await expect(resumedManager.startResumed({
      ...input, agent: getAgent('codex')!, beforeDispatch: () => {
        if (++checks === 2) throw new Error('Task deleted before dispatch')
      }
    })).rejects.toThrow(/Task deleted before dispatch/)
    expect((await requests()).slice(beforeGuarded).some((request) => request.method === 'turn/start')).toBe(false)
    expect(resumedManager.isRunning(input.taskId)).toBe(false)

    const manager = new AgentProcessManager(undefined, client('success'))
    onTestCleanup(async () => {
      await manager.close()
      manager.removeAllListeners()
    })
    const forwarded: string[] = []
    for (const name of ['event', 'session', 'usage']) manager.on(name, () => forwarded.push(name))
    const exited = once(manager, 'exit')
    manager.start({ ...input, agent: getAgent('codex')! })
    expect(manager.isRunning(input.taskId)).toBe(true)
    expect(() => manager.start({ ...input, agent: getAgent('codex')! })).toThrow(/already running/)
    const [exit] = await exited as [ExitInfo]
    expect(exit.code).toBe(0)
    expect(exit.result?.output).toBe(expected)
    expect(manager.isRunning(input.taskId)).toBe(false)
    expect(['event', 'session', 'usage'].every((name) => forwarded.includes(name))).toBeTruthy()
    const cancellation = new AgentProcessManager(undefined, client('cancel-hang'))
    onTestCleanup(async () => {
      await cancellation.close()
      cancellation.removeAllListeners()
    })
    const cancelledExit = once(cancellation, 'exit')
    cancellation.start({ ...input, agent: getAgent('codex')! })
    cancellation.cancelAll()
    expect(((await cancelledExit) as [ExitInfo])[0].cancelled).toBe(true)
    expect(cancellation.isRunning(input.taskId)).toBe(false)

  } finally {
    await Promise.all(clients.map((executor) => executor.close()))
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

test('sends exact inline image data to Codex and rejects models without vision', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anvil-codex-images-'))
  onTestCleanup(() => rm(directory, { recursive: true, force: true }))
  const images = await taskImages()
  const fixture = resolve('tests/fixtures/codex-app-server.cjs')
  for (const scenario of ['image-success', 'image-unsupported', 'missing-rollout']) {
    const transcript = join(directory, `${scenario}.jsonl`)
    const client = new CodexAppServerClient({ workspace: testWorkspace(), command: process.execPath, args: [fixture, scenario, transcript], requestTimeoutMs: 5000 })
    onTestCleanup(() => client.close())
    const events: TaskEvent[] = []
    const result = await client.execute({
      workspace: testWorkspace(),
      taskId: scenario, cwd: directory, prompt: 'Implement the issue', images,
      model: scenario === 'missing-rollout' ? 'reasoner' : 'test-model',
      ...(scenario === 'missing-rollout' ? { resumeSessionId: 'old', resumeFallbackPrompt: 'Recover the saved plan and branch' } : {})
    }, (event) => events.push(event))
    const sent = (await readFile(transcript, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    const turn = sent.find((entry) => entry.method === 'turn/start')
    if (scenario === 'image-unsupported') {
      expect(result.status).toBe('failed')
      expect(result.error).toMatch(/does not advertise image input/)
      expect(turn).toBeUndefined()
      expect(sent.some((entry) => entry.method === 'thread/start')).toBe(false)
    } else {
      expect(result.status, result.error).toBe('succeeded')
      expect(turn.params.input[0].text).toBe(scenario === 'missing-rollout' ? 'Recover the saved plan and branch' : 'Implement the issue')
      expect(turn.params.input.slice(1)).toEqual(images.map((image) => ({ type: 'image', url: `data:${image.mimeType};base64,${Buffer.from(image.bytes).toString('base64')}` })))
    }
    expect(JSON.stringify(events)).not.toContain(Buffer.from(images[0].bytes).toString('base64'))
    await client.close()
  }
})
