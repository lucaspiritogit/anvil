import { expect, test, vi } from 'vitest'
import { spawn } from 'node-pty'
import { TerminalManager } from '../src/main/terminal'
import { onTestCleanup } from './test-cleanup'

vi.mock('node-pty', () => ({ spawn: vi.fn() }))

function shell() {
  let data = (_data: string): void => {}
  const exits: Array<(event: { exitCode: number }) => void> = []
  const term = {
    write: vi.fn(), resize: vi.fn(), kill: vi.fn(() => { for (const exit of exits) exit({ exitCode: 0 }) }),
    onData: (listener: typeof data) => { data = listener },
    onExit: (listener: (event: { exitCode: number }) => void) => { exits.push(listener) }
  }
  vi.mocked(spawn).mockReturnValue(term as unknown as ReturnType<typeof spawn>)
  return { term, data: (value: string) => data(value), exit: (code: number) => { for (const exit of exits) exit({ exitCode: code }) } }
}

test('reuses project shells and restores bounded output with ordered events', () => {
  vi.stubEnv('SHELL', '/bin/zsh')
  const process = shell()
  const handlers = { onData: vi.fn(), onExit: vi.fn() }
  const manager = new TerminalManager(handlers)
  onTestCleanup(() => manager.close())
  manager.create('project', '/project/root', 100, 30)
  manager.create('project', '/task/worktree', 80, 24)
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(spawn).toHaveBeenCalledWith('/bin/zsh', ['-l'], expect.objectContaining({ cwd: '/project/root', cols: 100, rows: 30, env: expect.objectContaining({ PWD: '/project/root' }) }))
  process.data('prompt$ ')
  process.data('hello\r\n')
  expect(manager.snapshot('project')).toEqual({ data: 'prompt$ hello\r\n', sequence: 2 })
  expect(handlers.onData).toHaveBeenLastCalledWith('project', 'hello\r\n', 2)
  manager.write('project', 'pwd\r')
  manager.resize('project', 120, 40)
  expect(process.term.write).toHaveBeenCalledWith('pwd\r')
  expect(process.term.resize).toHaveBeenCalledWith(120, 40)
  process.data('x'.repeat(250_000))
  expect(manager.snapshot('project').data).toHaveLength(200_000)
})

test('project deletion stops its shell and a delayed exit cannot remove a replacement session', () => {
  vi.mocked(spawn).mockClear()
  const old = shell()
  const handlers = { onData: vi.fn(), onExit: vi.fn() }
  const manager = new TerminalManager(handlers)
  onTestCleanup(() => manager.close())
  manager.create('project', '/project')
  manager.dispose('project')
  expect(old.term.kill).toHaveBeenCalledOnce()
  expect(manager.has('project')).toBe(false)
  const replacement = shell()
  manager.create('project', '/project')
  old.exit(0)
  old.data('stale output')
  expect(manager.has('project')).toBe(true)
  expect(manager.snapshot('project')).toEqual({ data: '', sequence: 0 })
  replacement.exit(0)
  expect(manager.has('project')).toBe(false)
  expect(handlers.onExit).toHaveBeenCalledExactlyOnceWith('project', 0)
})


test('shutdown waits for terminals and rejects new shells', async () => {
  const process = shell()
  const manager = new TerminalManager({ onData: vi.fn(), onExit: vi.fn() })
  onTestCleanup(() => manager.close())
  manager.create('project', '/project')
  const closing = manager.close()
  expect(manager.close()).toBe(closing)
  expect(() => manager.create('new', '/project')).toThrow('shutting down')
  await closing
  expect(process.term.kill).toHaveBeenCalledWith('SIGHUP')
  expect(process.term.kill).toHaveBeenCalledWith('SIGKILL')
  expect(manager.has('project')).toBe(false)
})
