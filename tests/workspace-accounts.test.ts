import { expect, test, vi } from 'vitest'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node-pty'
import { WorkspaceAccounts, parseOpenCodeAccounts } from '../src/main/agents/workspace-accounts'
import { AgentProcessManager } from '../src/main/agents/process-manager'
import type { ConnectionHandlers } from '../src/main/agents/codex-app-server-connection'
import type { CodexAccount, CodexAppServerRequests } from '../src/main/agents/codex-app-server-protocol'
import type { AgentAccountTarget } from '../src/shared/types'
import { testWorkspace } from './workspace-fixture'
import { onTestCleanup } from './test-cleanup'
import { getAgent } from '../src/main/agents/registry'

vi.mock('node-pty', () => ({ spawn: vi.fn() }))
vi.mock('../src/main/agents/resolve', () => ({ resolveCommand: () => ({ command: '/fake/opencode', prefixArgs: [], viaShell: false }) }))

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
    verifyOpenCode: async () => {}, readOpenCode: async (workspace) => profiles.has(workspace.workspaceId) ? '● OpenAI oauth\n1 credential' : '0 credentials',
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
          if (method === 'account/read') result = { account: profiles.get(workspace.workspaceId) ?? null, requiresOpenaiAuth: true, secret: 'never-return-this' }
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
  return { accounts, profiles, connections, locked, active, changed, invalidate, openBrowser, requests,
    rejectKey: () => { rejectKey = true }, early: () => { early = true } }
}

function nativeTerminal() {
  let data = (_value: string): void => {}
  const exits: Array<(event: { exitCode: number }) => void> = []
  const terminal = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(() => exits.forEach((exit) => exit({ exitCode: 0 }))),
    onData: (handler: typeof data) => { data = handler }, onExit: (handler: typeof exits[number]) => { exits.push(handler) } }
  vi.mocked(spawn).mockReturnValue(terminal as unknown as ReturnType<typeof spawn>)
  return { terminal, data: (value: string) => data(value), exit: (exitCode: number) => exits.forEach((exit) => exit({ exitCode })) }
}

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

test('native OpenCode login preserves prompts and exact profile environment, then refreshes after exit', async () => {
  const f = fixture()
  const term = nativeTerminal()
  const target = { ...work, agentId: 'opencode' as const }
  const pending = await f.accounts.connect({ ...target, method: 'native' })
  expect(pending).toMatchObject({ status: 'pending', terminal: true })
  expect(spawn).toHaveBeenLastCalledWith('/fake/opencode', ['auth', 'login'], expect.objectContaining({
    cwd: testWorkspace('work').home,
    env: expect.objectContaining({ HOME: testWorkspace('work').home, CODEX_HOME: testWorkspace('work').codexHome, OPENCODE_PURE: 'true' })
  }))
  const environment = vi.mocked(spawn).mock.lastCall?.[2]?.env
  expect(environment).not.toHaveProperty('OPENAI_API_KEY')
  term.data('Choose API key or subscription\r\n')
  expect(f.accounts.terminal(target, pending.sessionId!).data).toContain('Choose API key or subscription')
  f.accounts.terminal({ ...personal, agentId: 'opencode' }, pending.sessionId!, { data: 'wrong-workspace' })
  expect(term.terminal.write).not.toHaveBeenCalled()
  f.accounts.terminal(target, pending.sessionId!, { data: 'native-input', cols: 110, rows: 22 })
  expect(term.terminal.write).toHaveBeenCalledWith('native-input')
  expect(term.terminal.resize).toHaveBeenCalledWith(110, 22)
  f.profiles.set('work', { type: 'apiKey' })
  term.exit(0)
  await expect.poll(() => f.locked.size).toBe(0)
  expect((await f.accounts.status(target)).accounts).toEqual(['OpenAI: subscription'])
  expect(JSON.stringify(f.changed.mock.calls)).not.toContain('native-input')
})

test('OpenCode cancellation, failed exit, retry and logout all own their managed process', async () => {
  const f = fixture()
  const target = { ...work, agentId: 'opencode' as const }
  const first = nativeTerminal()
  const pending = await f.accounts.connect({ ...target, method: 'native' })
  expect((await f.accounts.cancel(target, pending.sessionId!)).status).toBe('cancelled')
  expect(first.terminal.kill).toHaveBeenCalled()
  const second = nativeTerminal()
  await f.accounts.disconnect(target)
  expect(spawn).toHaveBeenLastCalledWith('/fake/opencode', ['auth', 'logout'], expect.anything())
  first.exit(0)
  expect(f.locked.has('work')).toBe(true)
  second.exit(1)
  await expect.poll(() => f.locked.size).toBe(0)
  expect(f.changed.mock.lastCall?.[0].status).toBe('error')
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
