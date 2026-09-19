import { expect, test, vi } from 'vitest'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TerminalSessionManager, ensureNodePtySpawnHelperExecutable } from '../apps/server/src/terminal-sessions'
import { validateIpcRequest } from '../apps/server/src/handlers/validation'
import type { Store } from '../apps/server/src/store'

const native = vi.hoisted(() => ({ spawn: vi.fn(), resolveCommand: vi.fn() }))
vi.mock('node-pty', () => native)
vi.mock('../apps/server/src/process-tree', () => ({ closeProcessTree: async (_pid: number, _closed: Promise<void>, terminate: (force: boolean) => void) => terminate(false) }))
vi.mock('../apps/server/src/agents/resolve', () => ({ resolveCommand: native.resolveCommand }))
vi.mock('../apps/server/src/agents/opencode-workspace', () => ({
  openCodeWorkspaceCommand: (workspace: { home: string; environment: NodeJS.ProcessEnv }, args: string[]) => ({
    command: 'opencode', args, cwd: workspace.home, environment: workspace.environment
  })
}))

test('makes the node-pty spawn helper executable at runtime', () => {
  const root = mkdtempSync(join(tmpdir(), 'anvil-node-pty-'))
  const packageDirectory = join(root, 'app.asar', 'node_modules', 'node-pty')
  const helperDirectory = join(root, 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds', 'darwin-arm64')
  const helper = join(helperDirectory, 'spawn-helper')
  try {
    mkdirSync(helperDirectory, { recursive: true })
    writeFileSync(helper, '')
    chmodSync(helper, 0o644)
    ensureNodePtySpawnHelperExecutable({ platform: 'darwin', architecture: 'arm64', packageDirectory })
    expect(statSync(helper).mode & 0o111).not.toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  let data = (_value: string): void => {}
  let exit = (_value: { exitCode: number }): void => {}
  const subscription = { dispose: vi.fn() }
  const pty = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    onData: vi.fn((callback) => { data = callback; return subscription }),
    onExit: vi.fn((callback) => { exit = callback; return subscription }) }
  native.spawn.mockReset().mockReturnValue(pty)
  native.resolveCommand.mockReset().mockImplementation((command: string) =>
    ({ command: command === 'codex' ? '/bin/codex' : '/bin/opencode', prefixArgs: [], viaShell: false }))
  const store = { getProjects: () => [{ id: 'project', path: '/project' }], getActiveWorkspace: () => ({ id: 'default' }) } as unknown as Store
  const broadcast = vi.fn()
  const manager = new TerminalSessionManager(store, broadcast)
  return { manager, pty, broadcast, data: (value: string) => data(value), exit: (value: number) => exit({ exitCode: value }) }
}

test('project sessions resolve identity, buffer output, resize, exit and dispose', async () => {
  const f = fixture()
  const { sessionId } = f.manager.createProject({ projectId: 'project', cols: 80, rows: 24 })
  expect(native.spawn).toHaveBeenCalledWith(expect.any(String), [], expect.objectContaining({ cwd: '/project', cols: 80, rows: 24, name: 'xterm-256color' }))
  f.data('$ ')
  expect(f.manager.attach(sessionId)).toMatchObject({ data: '$ ', sequence: 1 })
  f.manager.write(sessionId, 'ls\r')
  f.manager.resize(sessionId, 90, 30)
  expect(f.pty.write).toHaveBeenCalledWith('ls\r')
  expect(f.pty.resize).toHaveBeenCalledWith(90, 30)
  f.exit(0)
  expect(f.broadcast).toHaveBeenLastCalledWith('terminals:exit', { sessionId, exitCode: 0 })
  expect(f.manager.attach(sessionId).exitCode).toBe(0)
  await f.manager.dispose(sessionId)
  expect(f.pty.kill).not.toHaveBeenCalled()
  expect(() => f.manager.attach(sessionId)).toThrow('not found')
  expect(() => f.manager.createProject({ projectId: 'missing', cols: 80, rows: 24 })).toThrow('Project not found')
})

test('auth spawns directly with only the isolated environment; disposeAll kills live sessions', async () => {
  const f = fixture()
  const onExit = vi.fn()
  f.manager.createOpenCodeAuth({ workspaceId: 'work', directory: '/work', home: '/work/home', codexHome: '/work/codex', environment: { HOME: '/work/home', PATH: '/bin' } }, false, onExit)
  expect(native.spawn).toHaveBeenCalledWith('/bin/opencode', ['auth', 'login'], expect.objectContaining({ cwd: '/work/home', env: { HOME: '/work/home', PATH: '/bin' } }))
  await f.manager.disposeProjects()
  expect(f.pty.kill).not.toHaveBeenCalled()
  f.manager.createProject({ projectId: 'project', cols: 80, rows: 24 })
  await f.manager.disposeAll()
  expect(f.pty.kill).toHaveBeenCalledTimes(2)
  await f.manager.disposeAll()
  expect(f.pty.kill).toHaveBeenCalledTimes(2)
})

test('codex auth spawns codex login --device-auth with the isolated codex home environment', () => {
  const f = fixture()
  const onExit = vi.fn()
  const { sessionId } = f.manager.createCodexAuth({ workspaceId: 'work', directory: '/work', home: '/work/home', codexHome: '/work/codex', environment: { HOME: '/work/home', PATH: '/bin', CODEX_HOME: '/work/codex' } }, onExit)
  expect(native.spawn).toHaveBeenCalledWith('/bin/codex',
    ['login', '--device-auth', '-c', 'cli_auth_credentials_store="file"'],
    expect.objectContaining({ cwd: '/work/home', env: { HOME: '/work/home', PATH: '/bin', CODEX_HOME: '/work/codex' }, cols: 80, rows: 10 }))
  f.exit(0)
  expect(onExit).toHaveBeenCalledWith(0)
  expect(f.manager.attach(sessionId).exitCode).toBe(0)
})

test('codex auth fails clearly when codex is missing or only a shell shim', () => {
  const f = fixture()
  const workspace = { workspaceId: 'work', directory: '/work', home: '/work/home', codexHome: '/work/codex', environment: { HOME: '/work/home' } }
  native.resolveCommand.mockReturnValue(null)
  expect(() => f.manager.createCodexAuth(workspace, vi.fn())).toThrow('Codex requires a directly executable CLI')
  native.resolveCommand.mockReturnValue({ command: 'C:\\Program Files\\codex\\codex.exe', prefixArgs: [], viaShell: true })
  expect(() => f.manager.createCodexAuth(workspace, vi.fn())).toThrow('Codex requires a directly executable CLI')
})

test('terminal IPC rejects paths, commands, environment and invalid dimensions, but accepts control bytes', () => {
  const input = { projectId: 'project', cols: 80, rows: 24 }
  for (const extra of [{ cwd: '/tmp' }, { command: 'sh' }, { env: {} }, { cols: 0 }, { rows: 301 }]) {
    expect(() => validateIpcRequest('terminals:create', [{ ...input, ...extra }])).toThrow('Invalid IPC')
  }
  expect(validateIpcRequest('terminals:create', [input])).toEqual(input)
  expect(validateIpcRequest('terminals:write', [{ sessionId: 'session', data: '\0\x03\r' }]).data).toBe('\0\x03\r')
})
