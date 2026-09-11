import { expect, test, vi } from 'vitest'
import { TerminalSessionManager } from '../src/server/terminal-sessions'
import { validateIpcRequest } from '../src/server/handlers/validation'
import type { Store } from '../src/server/store'

const native = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node-pty', () => native)
vi.mock('../src/server/process-tree', () => ({ closeProcessTree: async (_pid: number, _closed: Promise<void>, terminate: (force: boolean) => void) => terminate(false) }))
vi.mock('../src/server/agents/resolve', () => ({ resolveCommand: () => ({ command: '/bin/opencode', prefixArgs: [], viaShell: false }) }))
vi.mock('../src/server/agents/opencode-workspace', () => ({
  openCodeWorkspaceCommand: (workspace: { home: string; environment: NodeJS.ProcessEnv }, args: string[]) => ({
    command: 'opencode', args, cwd: workspace.home, environment: workspace.environment
  })
}))

function fixture() {
  let data = (_value: string): void => {}
  let exit = (_value: { exitCode: number }): void => {}
  const subscription = { dispose: vi.fn() }
  const pty = { write: vi.fn(), resize: vi.fn(), kill: vi.fn(),
    onData: vi.fn((callback) => { data = callback; return subscription }),
    onExit: vi.fn((callback) => { exit = callback; return subscription }) }
  native.spawn.mockReset().mockReturnValue(pty)
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

test('terminal IPC rejects paths, commands, environment and invalid dimensions, but accepts control bytes', () => {
  const input = { projectId: 'project', cols: 80, rows: 24 }
  for (const extra of [{ cwd: '/tmp' }, { command: 'sh' }, { env: {} }, { cols: 0 }, { rows: 301 }]) {
    expect(() => validateIpcRequest('terminals:create', [{ ...input, ...extra }])).toThrow('Invalid IPC')
  }
  expect(validateIpcRequest('terminals:create', [input])).toEqual(input)
  expect(validateIpcRequest('terminals:write', [{ sessionId: 'session', data: '\0\x03\r' }]).data).toBe('\0\x03\r')
})
