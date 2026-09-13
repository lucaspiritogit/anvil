import { expect, test, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { TerminalSessionManager } from '../src/server/terminal-sessions'
import { WorkspaceAccounts, parseOpenCodeAccounts } from '../src/server/agents/workspace-accounts'
import { AgentProcessManager } from '../src/server/agents/process-manager'
import type { ConnectionHandlers } from '../src/server/agents/codex-app-server-connection'
import type { CodexAccount, CodexAppServerRequests } from '../src/server/agents/codex-app-server-protocol'
import type { AgentAccountConnect, AgentAccountTarget } from '../src/shared/types'
import { validateIpcRequest } from '../src/server/handlers/validation'
import { testWorkspace } from './workspace-fixture'
import { onTestCleanup } from './test-cleanup'
import { getAgent } from '../src/server/agents/registry'

vi.mock('../src/server/agents/resolve', () => ({ resolveCommand: () => ({ command: '/fake/opencode', prefixArgs: [], viaShell: false }) }))

vi.mock('node:fs/promises', async () => {
  const real = await vi.importActual<any>('node:fs/promises')
  let gate: Promise<unknown> | undefined
  return {
    ...real,
    async stat(path: unknown, options?: unknown) {
      if (gate) await gate
      return real.stat(path, options)
    },
    __setStatGate(promise: Promise<unknown> | undefined) { gate = promise }
  }
})

const work: AgentAccountTarget = { workspaceId: 'work', agentId: 'codex' }
const personal: AgentAccountTarget = { workspaceId: 'personal', agentId: 'codex' }

function fixture() {
  const profiles = new Map<string, CodexAccount | null>()
  const connections: Array<{ workspaceId: string; handlers: ConnectionHandlers; close: ReturnType<typeof vi.fn>; loginId: string }> = []
  const active = new Set<string>()
  const locked = new Set<string>()
  const changed = vi.fn()
  const invalidate = vi.fn(async (_workspaceId: string) => {})
  const openBrowser = vi.fn(async () => {})
  const createOpenCodeAuth = vi.fn<TerminalSessionManager['createOpenCodeAuth']>(() => ({ sessionId: 'auth-terminal' }))
  const createCodexAuth = vi.fn<TerminalSessionManager['createCodexAuth']>(() => ({ sessionId: 'codex-terminal' }))
  const dispose = vi.fn(async () => {})
  let readGate: Promise<void> | undefined
  const readOpenCode = vi.fn(async (workspace: { workspaceId: string }): Promise<string> => {
    if (readGate) await readGate
    return profiles.has(workspace.workspaceId) ? '● OpenAI oauth\n1 credential' : '0 credentials'
  })
  let rejectKey = false
  let early = false
  const requests: string[] = []
  const accounts = new WorkspaceAccounts({
    getWorkspaceDirectory: (id) => testWorkspace(id).directory,
    getWorkspaces: () => ['work', 'personal'].map((id) => ({ id, name: id, createdAt: 0 }))
  }, {
    acquire: (id) => {
      if (active.has(id) || locked.has(id)) throw new Error('busy')
      locked.add(id)
      return () => { locked.delete(id) }
    },
    busy: (id) => active.has(id), invalidate, changed, openBrowser,
    readOpenCode, terminals: { createOpenCodeAuth, createCodexAuth, dispose },
    connection: (workspace, handlers) => {
      const connection = { workspaceId: workspace.workspaceId, handlers, close: vi.fn(async () => {}), loginId: `login-${connections.length}` }
      connections.push(connection)
      return {
        failure: new Promise<never>(() => {}), close: connection.close, initialized: () => {},
        async request<M extends keyof CodexAppServerRequests>(method: M, params: CodexAppServerRequests[M]['params']): Promise<CodexAppServerRequests[M]['result']> {
          requests.push(method)
          let result: unknown = {}
          if (method === 'config/read') result = { config: { cli_auth_credentials_store: 'file' } }
          if (method === 'initialize') result = { userAgent: 'fake' }
          if (method === 'account/read') {
            if (readGate) await readGate
            result = { account: profiles.get(workspace.workspaceId) ?? null, requiresOpenaiAuth: true, secret: 'never-return-this' }
          }
          if (method === 'account/login/start') {
            const login = params as CodexAppServerRequests['account/login/start']['params']
            if (login.type === 'apiKey') {
              if (rejectKey) throw new Error(`Rejected secret ${login.apiKey}`)
              profiles.set(workspace.workspaceId, { type: 'apiKey' })
              result = { type: 'apiKey', apiKey: login.apiKey }
            } else {
              if (early) {
                profiles.set(workspace.workspaceId, { type: 'chatgpt', email: 'fixture@example.test', planType: 'plus' })
                handlers.notification('account/login/completed', { loginId: connection.loginId, success: true })
              }
              result = { type: 'chatgpt', loginId: connection.loginId, authUrl: 'https://auth.openai.com/authorize?state=fixture' }
            }
          }
          if (method === 'account/login/cancel') result = { status: 'canceled' }
          if (method === 'account/logout') profiles.delete(workspace.workspaceId)
          return result as CodexAppServerRequests[M]['result']
        }
      }
    }
  })
  onTestCleanup(() => accounts.close())
  return { accounts, profiles, connections, locked, active, changed, invalidate, openBrowser, createOpenCodeAuth, createCodexAuth, dispose, readOpenCode, requests,
    rejectKey: () => { rejectKey = true }, early: () => { early = true }, setReadGate: (gate?: Promise<void>) => { readGate = gate } }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

interface TerminalAuthCase {
  name: string
  target: AgentAccountTarget
  connect: AgentAccountConnect
  terminalSessionId: string
  exit(f: ReturnType<typeof fixture>, exitCode: number): void
}

const terminalAuthCases: TerminalAuthCase[] = [
  {
    name: 'Codex device auth', target: work, connect: { ...work, method: 'deviceAuth' }, terminalSessionId: 'codex-terminal',
    exit: (f, exitCode) => { f.createCodexAuth.mock.lastCall![1](exitCode) }
  },
  {
    name: 'OpenCode native auth', target: { ...work, agentId: 'opencode' }, connect: { ...work, agentId: 'opencode', method: 'native' }, terminalSessionId: 'auth-terminal',
    exit: (f, exitCode) => { f.createOpenCodeAuth.mock.lastCall![2](exitCode) }
  }
]

test.each(terminalAuthCases)('$name detaches its terminal before delayed cleanup and refresh complete', async ({ target, connect, terminalSessionId, exit }) => {
  const f = fixture()
  const disposal = deferred()
  const refresh = deferred()
  f.dispose.mockImplementationOnce(() => disposal.promise)
  const pending = await f.accounts.connect(connect)
  const readsBeforeFinish = target.agentId === 'opencode'
    ? f.readOpenCode.mock.calls.length
    : f.requests.filter((method) => method === 'account/read').length
  f.profiles.set(target.workspaceId, { type: 'apiKey' })
  f.setReadGate(refresh.promise)
  const changesBeforeFinish = f.changed.mock.calls.length

  exit(f, 0)
  await vi.waitFor(() => expect(f.changed.mock.calls.length).toBe(changesBeforeFinish + 1))
  expect(f.changed.mock.calls[changesBeforeFinish][0]).toMatchObject({ status: 'pending', sessionId: pending.sessionId })
  expect(f.changed.mock.calls[changesBeforeFinish][0].terminalSessionId).toBeUndefined()
  expect(await f.accounts.status(target)).toMatchObject({ status: 'pending', sessionId: pending.sessionId })
  expect((await f.accounts.status(target)).terminalSessionId).toBeUndefined()
  expect(f.dispose).toHaveBeenCalledOnce()
  expect(f.dispose).toHaveBeenCalledWith(terminalSessionId)
  expect(f.locked.has(target.workspaceId)).toBe(true)

  exit(f, 1)
  await Promise.resolve()
  expect(f.dispose).toHaveBeenCalledOnce()
  expect(f.changed.mock.calls.length).toBe(changesBeforeFinish + 1)

  disposal.resolve()
  await vi.waitFor(() => {
    const reads = target.agentId === 'opencode'
      ? f.readOpenCode.mock.calls.length
      : f.requests.filter((method) => method === 'account/read').length
    expect(reads).toBe(readsBeforeFinish + 1)
  })
  expect((await f.accounts.status(target)).terminalSessionId).toBeUndefined()
  expect(f.locked.has(target.workspaceId)).toBe(true)

  refresh.resolve()
  await vi.waitFor(() => expect(f.locked.has(target.workspaceId)).toBe(false))
  expect(await f.accounts.status(target)).toMatchObject({ status: 'connected' })
  expect((await f.accounts.status(target)).terminalSessionId).toBeUndefined()
})

test.each(terminalAuthCases)('$name cancellation detaches its terminal while retaining operation ownership', async ({ target, connect, terminalSessionId, exit }) => {
  const f = fixture()
  const disposal = deferred()
  f.dispose.mockImplementationOnce(() => disposal.promise)
  const pending = await f.accounts.connect(connect)
  const changesBeforeFinish = f.changed.mock.calls.length

  const cancellation = f.accounts.cancel(target, pending.sessionId!)
  await vi.waitFor(() => expect(f.changed.mock.calls.length).toBe(changesBeforeFinish + 1))
  expect(await f.accounts.status(target)).toMatchObject({ status: 'pending', sessionId: pending.sessionId })
  expect((await f.accounts.status(target)).terminalSessionId).toBeUndefined()
  expect(f.dispose).toHaveBeenCalledWith(terminalSessionId)
  expect(f.locked.has(target.workspaceId)).toBe(true)

  exit(f, 1)
  await Promise.resolve()
  expect(f.dispose).toHaveBeenCalledOnce()
  expect(f.changed.mock.calls.length).toBe(changesBeforeFinish + 1)

  disposal.resolve()
  expect(await cancellation).toMatchObject({ status: 'cancelled', message: 'Connection cancelled.' })
  expect(f.locked.has(target.workspaceId)).toBe(false)
  expect((await f.accounts.status(target)).terminalSessionId).toBeUndefined()
})

test.each(terminalAuthCases)('$name publishes terminal detachment before failed cleanup', async ({ target, connect, exit }) => {
  const f = fixture()
  f.dispose.mockRejectedValueOnce(new Error('native teardown failed'))
  await f.accounts.connect(connect)
  const changesBeforeFinish = f.changed.mock.calls.length

  exit(f, 0)
  await vi.waitFor(() => expect(f.changed.mock.calls.length).toBe(changesBeforeFinish + 2))
  expect(f.changed.mock.calls[changesBeforeFinish][0]).toMatchObject({ status: 'pending' })
  expect(f.changed.mock.calls[changesBeforeFinish][0].terminalSessionId).toBeUndefined()
  expect(f.changed.mock.calls[changesBeforeFinish + 1][0]).toMatchObject({
    status: 'error', message: 'Could not finish account cleanup. Restart Anvil before retrying.'
  })
  expect(f.locked.has(target.workspaceId)).toBe(true)

  exit(f, 1)
  await Promise.resolve()
  expect(f.dispose).toHaveBeenCalledOnce()
  expect(f.changed.mock.calls.length).toBe(changesBeforeFinish + 2)
})

test('API key success, failure redaction, logout and native summaries are workspace scoped', async () => {
  const f = fixture()
  const sentinel = join(testWorkspace('global').codexHome, 'auth.json')
  writeFileSync(sentinel, 'global sentinel')
  expect(await f.accounts.status(work)).toMatchObject({ workspaceId: 'work', status: 'signed-out' })
  expect(await f.accounts.connect({ ...work, method: 'apiKey', apiKey: 'sk-fixture-secret' })).toMatchObject({ status: 'connected', accounts: ['API key'] })
  expect(await f.accounts.status(personal)).toMatchObject({ status: 'signed-out' })
  expect(await f.accounts.disconnect(work)).toMatchObject({ status: 'signed-out' })
  f.rejectKey()
  const failed = await f.accounts.connect({ ...personal, method: 'apiKey', apiKey: 'sk-fixture-secret' })
  expect(failed.status).toBe('error')
  expect(JSON.stringify([failed, f.changed.mock.calls])).not.toContain('sk-fixture-secret')
  expect(JSON.stringify(f.changed.mock.calls)).not.toContain('never-return-this')
  expect(readFileSync(sentinel, 'utf8')).toBe('global sentinel')
  expect(f.locked.size).toBe(0)
  expect(f.requests).toContain('account/logout')
})

test('subscription completion keeps its workspace when selection changes and ignores stale callbacks', async () => {
  const f = fixture()
  const started = await f.accounts.connect({ ...work, method: 'chatgpt' })
  const connection = f.connections[0]
  expect(started).toMatchObject({ status: 'pending', workspaceId: 'work' })
  expect(f.openBrowser).toHaveBeenCalledOnce()
  await f.accounts.status(personal)
  connection.handlers.notification('account/login/completed', { loginId: 'stale', success: true })
  expect((await f.accounts.status(work)).status).toBe('pending')
  f.profiles.set('work', { type: 'chatgpt', email: 'work@example.test', planType: 'business' })
  connection.handlers.notification('account/login/completed', { loginId: connection.loginId, success: true })
  await expect.poll(() => f.locked.size).toBe(0)
  expect(await f.accounts.status(work)).toMatchObject({ status: 'connected', accounts: ['ChatGPT: work@example.test (business)'] })
  expect((await f.accounts.status(personal)).status).toBe('signed-out')
  expect(f.invalidate.mock.calls.every(([id]) => id === 'work')).toBe(true)
})

test('cancellation and retry bind session IDs; failed and early native callbacks are handled', async () => {
  const f = fixture()
  const first = await f.accounts.connect({ ...work, method: 'chatgpt' })
  expect((await f.accounts.cancel(work, 'stale')).status).toBe('pending')
  expect((await f.accounts.cancel(work, first.sessionId!)).status).toBe('cancelled')
  expect(f.requests).toContain('account/login/cancel')
  const second = await f.accounts.connect({ ...work, method: 'chatgpt' })
  f.connections[0].handlers.notification('account/login/completed', { loginId: f.connections[0].loginId, success: true })
  expect((await f.accounts.status(work)).sessionId).toBe(second.sessionId)
  const current = f.connections.find((connection) => !connection.close.mock.calls.length)!
  current.handlers.notification('account/login/completed', { loginId: current.loginId, success: false, error: 'secret-provider-token' })
  await expect.poll(() => f.locked.size).toBe(0)
  expect(JSON.stringify(f.changed.mock.calls)).not.toContain('secret-provider-token')
  expect(f.changed.mock.lastCall?.[0].status).toBe('error')
  f.early()
  expect((await f.accounts.connect({ ...work, method: 'chatgpt' })).status).toBe('connected')
})

test('busy work prevents account mutations while another workspace can connect', async () => {
  const f = fixture()
  f.active.add('work')
  expect((await f.accounts.disconnect(work)).status).toBe('busy')
  expect(f.connections).toHaveLength(0)
  expect((await f.accounts.connect({ ...personal, method: 'chatgpt' })).status).toBe('pending')
  expect((await f.accounts.connect({ ...personal, method: 'apiKey', apiKey: 'secret' })).status).toBe('busy')
  expect(f.active.has('work')).toBe(true)
})

test('OpenCode login launches with the exact workspace environment and polls for accounts', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = fixture()
  const target = { ...work, agentId: 'opencode' as const }
  const pending = await f.accounts.connect({ ...target, method: 'native' })
  expect(pending.status).toBe('pending')
  expect(pending.terminalSessionId).toBe('auth-terminal')
  expect(f.createOpenCodeAuth).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'work' }), false, expect.any(Function))
  await vi.advanceTimersByTimeAsync(3000)
  expect((await f.accounts.status(target)).status).toBe('pending')
  f.profiles.set('work', { type: 'apiKey' })
  await vi.waitFor(() => expect(f.locked.size).toBe(0), { timeout: 5000 })
  expect((await f.accounts.status(target)).accounts).toEqual(['OpenAI: subscription'])
  expect((await f.accounts.status({ ...personal, agentId: 'opencode' })).status).toBe('signed-out')
})

test('OpenCode existing credentials wait for a new auth write, including the same provider', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = fixture()
  const target = { ...work, agentId: 'opencode' as const }
  f.profiles.set('work', { type: 'apiKey' })
  await f.accounts.connect({ ...target, method: 'native' })
  await vi.advanceTimersByTimeAsync(3000)
  expect((await f.accounts.status(target)).status).toBe('pending')
  const directory = join(testWorkspace('work').directory, 'data', 'opencode')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'auth.json'), '{}')
  await vi.waitFor(() => expect(f.locked.size).toBe(0), { timeout: 5000 })
  expect((await f.accounts.status(target)).status).toBe('connected')
})

test('OpenCode cancellation, launch failure, timeout and logout release the workspace', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = fixture()
  const target = { ...work, agentId: 'opencode' as const }
  const first = await f.accounts.connect({ ...target, method: 'native' })
  expect((await f.accounts.cancel(target, 'stale')).status).toBe('pending')
  expect((await f.accounts.cancel(target, first.sessionId!)).status).toBe('cancelled')
  expect(f.locked.size).toBe(0)
  f.createOpenCodeAuth.mockImplementationOnce(() => { throw new Error('sensitive launcher details') })
  expect((await f.accounts.connect({ ...target, method: 'native' })).status).toBe('error')
  expect(JSON.stringify(f.changed.mock.calls)).not.toContain('sensitive launcher details')
  await f.accounts.connect({ ...target, method: 'native' })
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  await vi.waitFor(() => expect(f.locked.size).toBe(0))
  expect(f.changed.mock.lastCall?.[0].message).toContain('timed out')
  f.profiles.set('work', { type: 'apiKey' })
  await f.accounts.disconnect(target)
  expect(f.createOpenCodeAuth.mock.lastCall?.[1]).toBe(true)
  expect(f.dispose).toHaveBeenCalledWith('auth-terminal')
  f.profiles.delete('work')
  await vi.waitFor(() => expect(f.locked.size).toBe(0), { timeout: 5000 })
  expect((await f.accounts.status(target)).status).toBe('signed-out')
})

test('OpenCode ignores late polls after cancellation and does not overlap slow reads', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = fixture()
  const target = { ...work, agentId: 'opencode' as const }
  const pending = await f.accounts.connect({ ...target, method: 'native' })
  let resolve!: (value: string) => void
  f.readOpenCode.mockImplementationOnce(() => new Promise((done) => { resolve = done }))
  await vi.advanceTimersByTimeAsync(9000)
  expect(f.readOpenCode).toHaveBeenCalledTimes(2)
  await f.accounts.cancel(target, pending.sessionId!)
  resolve('● OpenAI oauth')
  await vi.advanceTimersByTimeAsync(6000)
  expect(f.changed.mock.lastCall?.[0].status).toBe('cancelled')
  expect(f.readOpenCode).toHaveBeenCalledTimes(3)
  expect(f.locked.size).toBe(0)
})

test('unknown provider output and secrets are not returned as native account summaries', () => {
  expect(parseOpenCodeAccounts('secret sk-secret\n● OpenAI api\n● Anthropic oauth\n● Unknown api token-secret')).toEqual(['OpenAI: API key', 'Anthropic: subscription'])
})

test('process manager locks tasks and PR drafting and invalidates only idle workspace clients', async () => {
  let finish!: (value: { status: 'succeeded'; output: string; taskId: string; changedFiles: [] }) => void
  const execute = vi.fn(() => new Promise<{ status: 'succeeded'; output: string; taskId: string; changedFiles: [] }>((resolve) => { finish = resolve }))
  const workClient = { execute, close: vi.fn(async () => {}) }
  const personalClient = { execute: vi.fn(async () => ({ status: 'succeeded' as const, output: 'done', taskId: 'fixture', changedFiles: [] })), close: vi.fn(async () => {}) }
  const manager = new AgentProcessManager(undefined, undefined, (_agent, workspace) => workspace.workspaceId === 'work' ? workClient : personalClient)
  onTestCleanup(() => manager.close())
  const agent = getAgent('codex')!
  const options = { agent, workspace: testWorkspace('work'), taskId: 'task-work', cwd: '/tmp', prompt: 'fixture' }
  manager.start(options)
  expect(manager.isWorkspaceBusy('work')).toBe(true)
  expect(() => manager.acquireAccountChange('work')).toThrow('active work')
  const releasePersonal = manager.acquireAccountChange('personal')
  expect(() => manager.start({ ...options, taskId: 'personal-task', workspace: testWorkspace('personal') })).toThrow('pending account change')
  await expect(manager.generateText({ ...options, workspace: testWorkspace('personal') })).rejects.toThrow('pending account change')
  releasePersonal()
  await manager.generateText({ ...options, workspace: testWorkspace('personal') })
  finish({ status: 'succeeded', output: 'done', taskId: 'fixture', changedFiles: [] })
  await expect.poll(() => manager.isWorkspaceBusy('work')).toBe(false)
  const release = manager.acquireAccountChange('work')
  await manager.invalidateWorkspaceClients('work')
  expect(workClient.close).toHaveBeenCalledOnce()
  expect(personalClient.close).not.toHaveBeenCalled()
  release()
})


test('browser launch rejection cancels native login and returns a fixed error without the URL', async () => {
  const f = fixture()
  f.openBrowser.mockRejectedValue(new Error('URL contained sensitive-state'))
  const result = await f.accounts.connect({ ...work, method: 'chatgpt' })
  expect(result.status).toBe('error')
  expect(f.requests).toContain('account/login/cancel')
  expect(f.connections[0].close).toHaveBeenCalledOnce()
  expect(JSON.stringify(f.changed.mock.calls)).not.toContain('sensitive-state')
  expect(f.locked.size).toBe(0)
})

test('cleanup failure keeps the workspace locked instead of risking a still-running native client', async () => {
  const f = fixture()
  await f.accounts.connect({ ...work, method: 'chatgpt' })
  f.connections[0].close.mockRejectedValue(new Error('native teardown failed'))
  const pending = await f.accounts.status(work)
  expect((await f.accounts.cancel(work, pending.sessionId!)).message).toContain('Restart Anvil')
  expect(f.locked.has('work')).toBe(true)
  expect((await f.accounts.connect({ ...work, method: 'apiKey', apiKey: 'secret' })).status).toBe('busy')
})


test('OpenCode process exit finishes authentication and disposes the PTY', async () => {
  const f = fixture()
  const target = { ...work, agentId: 'opencode' as const }
  await f.accounts.connect({ ...target, method: 'native' })
  f.createOpenCodeAuth.mock.lastCall![2](1)
  await vi.waitFor(() => expect(f.locked.size).toBe(0))
  expect(f.dispose).toHaveBeenCalledWith('auth-terminal')
  expect((await f.accounts.status(target)).status).toBe('signed-out')
})

test('Codex device auth launches the CLI terminal and completes on a fresh auth.json write', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = fixture()
  const pending = await f.accounts.connect({ ...work, method: 'deviceAuth' })
  expect(pending).toMatchObject({ status: 'pending', workspaceId: 'work', terminalSessionId: 'codex-terminal' })
  expect(pending.message).toContain('one-time code')
  expect(f.createCodexAuth).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceId: 'work', codexHome: expect.stringContaining(join('codex')) }),
    expect.any(Function))
  expect(f.createOpenCodeAuth).not.toHaveBeenCalled()
  expect(f.openBrowser).not.toHaveBeenCalled()
  expect(f.requests).not.toContain('account/login/start')
  const directory = join(testWorkspace('work').codexHome)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'auth.json'), '{"tokens":{"openai":{"access_token":"device"}}}')
  f.profiles.set('work', { type: 'chatgpt', email: 'remote@example.test', planType: 'plus' })
  await vi.advanceTimersByTimeAsync(3000)
  await vi.waitFor(() => expect(f.locked.size).toBe(0))
  expect((await f.accounts.status(work)).status).toBe('connected')
  expect((await f.accounts.status(personal)).status).toBe('signed-out')
  expect(f.dispose).toHaveBeenCalledWith('codex-terminal')
  expect(f.invalidate.mock.calls.every(([id]) => id === 'work')).toBe(true)
})

test('Codex device auth is gated per agent', async () => {
  const f = fixture()
  const pending = await f.accounts.connect({ ...work, method: 'deviceAuth' })
  expect(pending.status).toBe('pending')
  const target = { ...work, agentId: 'opencode' as const }
  await expect(f.accounts.connect({ ...target, method: 'deviceAuth' })).rejects.toThrow('Use native OpenCode login')
  await expect(f.accounts.connect({ ...work, method: 'unsupported' } as unknown as AgentAccountConnect)).rejects.toThrow('Unsupported Codex login method')
  expect((await f.accounts.cancel(work, pending.sessionId!)).status).toBe('cancelled')
  expect(f.locked.size).toBe(0)
})

test('Codex device auth cancellation and timeout release the workspace', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = fixture()
  const first = await f.accounts.connect({ ...work, method: 'deviceAuth' })
  expect(first.sessionId).toBeTruthy()
  expect((await f.accounts.cancel(work, 'stale')).status).toBe('pending')
  expect((await f.accounts.cancel(work, first.sessionId!)).status).toBe('cancelled')
  expect(f.locked.size).toBe(0)
  expect(f.dispose).toHaveBeenCalledWith('codex-terminal')
  await f.accounts.connect({ ...work, method: 'deviceAuth' })
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  await vi.waitFor(() => expect(f.locked.size).toBe(0))
  expect(f.changed.mock.lastCall?.[0].message).toContain('timed out')
})

test('Codex device auth terminal exit and launch failure use fixed messages', async () => {
  const f = fixture()
  f.createCodexAuth.mockImplementationOnce(() => { throw new Error('sensitive launcher details') })
  const failed = await f.accounts.connect({ ...work, method: 'deviceAuth' })
  expect(failed.status).toBe('error')
  expect(failed.message).toBe('Account operation failed. Check the native agent installation and retry.')
  expect(JSON.stringify(f.changed.mock.calls)).not.toContain('sensitive launcher details')
  expect(f.locked.size).toBe(0)
  await f.accounts.connect({ ...work, method: 'deviceAuth' })
  f.createCodexAuth.mock.lastCall![1](1)
  await vi.waitFor(() => expect(f.locked.size).toBe(0))
  expect(f.changed.mock.lastCall?.[0].status).toBe('error')
  expect(f.changed.mock.lastCall?.[0].message).toBe('Codex authentication stopped. Retry the connection.')
  await f.accounts.connect({ ...work, method: 'deviceAuth' })
  f.createCodexAuth.mock.lastCall![1](0)
  await vi.waitFor(() => expect(f.locked.size).toBe(0))
  expect((await f.accounts.status(work)).status).toBe('signed-out')
})

test('Codex device auth isolates stale in-flight polls from the next operation', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const fsPromises = await import('node:fs/promises')
  const setStatGate = (fsPromises as unknown as { __setStatGate(promise: Promise<unknown> | undefined): void }).__setStatGate
  const f = fixture()
  const directory = join(testWorkspace('work').codexHome)
  mkdirSync(directory, { recursive: true })
  const authFile = join(directory, 'auth.json')
  writeFileSync(authFile, '{}')
  const first = await f.accounts.connect({ ...work, method: 'deviceAuth' })
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  setStatGate(gate)
  try {
    await vi.advanceTimersByTimeAsync(3000)
    expect((await f.accounts.status(work)).status).toBe('pending')
    const cancelled = await f.accounts.cancel(work, first.sessionId!)
    expect(cancelled.status).toBe('cancelled')
    release()
    await vi.waitFor(() => expect(f.locked.size).toBe(0))
    expect(f.changed.mock.lastCall?.[0].status).toBe('cancelled')
    const second = await f.accounts.connect({ ...work, method: 'deviceAuth' })
    expect(second.status).toBe('pending')
    await vi.advanceTimersByTimeAsync(3000)
    // The stale signal (the auth.json written before the new poll started) does not complete the new operation.
    expect((await f.accounts.status(work)).sessionId).toBe(second.sessionId)
    writeFileSync(authFile, '{"tokens":{"fresh":true}}')
    f.profiles.set('work', { type: 'chatgpt', email: 'stale@example.test', planType: 'plus' })
    await vi.advanceTimersByTimeAsync(3000)
    await vi.waitFor(() => expect(f.locked.size).toBe(0))
    expect((await f.accounts.status(work)).status).toBe('connected')
  } finally {
    setStatGate(undefined)
  }
})

test('Codex device auth stays scoped to its workspace', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = fixture()
  const pending = await f.accounts.connect({ ...work, method: 'deviceAuth' })
  expect(pending.status).toBe('pending')
  expect((await f.accounts.status(personal)).status).toBe('signed-out')
  const directory = join(testWorkspace('work').codexHome)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'auth.json'), '{"scope":"work"}')
  f.profiles.set('work', { type: 'apiKey' })
  await vi.advanceTimersByTimeAsync(3000)
  await vi.waitFor(() => expect(f.locked.size).toBe(0))
  expect((await f.accounts.status(work)).status).toBe('connected')
  expect((await f.accounts.status(personal)).status).toBe('signed-out')
  expect(f.invalidate.mock.calls.every(([id]) => id === 'work')).toBe(true)
})

test('accounts:connect validator rejects deviceAuth for opencode and native for codex', () => {
  const target = { workspaceId: 'default' as const }
  expect(() => validateIpcRequest('accounts:connect', [{ ...target, agentId: 'codex', method: 'deviceAuth' }])).not.toThrow()
  expect(() => validateIpcRequest('accounts:connect', [{ ...target, agentId: 'codex', method: 'native' }])).toThrow('unsupported agent login method')
  expect(() => validateIpcRequest('accounts:connect', [{ ...target, agentId: 'opencode', method: 'deviceAuth' }])).toThrow('unsupported agent login method')
  expect(() => validateIpcRequest('accounts:connect', [{ ...target, agentId: 'opencode', method: 'native' }])).not.toThrow()
})
