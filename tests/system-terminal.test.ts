import { EventEmitter } from 'node:events'
import { expect, test, vi } from 'vitest'
import { openSystemTerminal } from '../src/main/system-terminal'
import { onTestCleanup } from './test-cleanup'

const native = vi.hoisted(() => ({ spawn: vi.fn(), execFile: vi.fn() }))
vi.mock('node:child_process', () => native)

function platform(value: NodeJS.Platform) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { value })
  onTestCleanup(() => { Object.defineProperty(process, 'platform', descriptor) })
  native.spawn.mockReset()
  native.execFile.mockReset()
  native.execFile.mockImplementation((_command, _args, _options, callback) => { callback(null); return {} })
  native.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() })
    queueMicrotask(() => child.emit('spawn'))
    return child
  })
}

test('Windows Terminal receives a literal cwd and an encoded workspace command', async () => {
  platform('win32')
  const cwd = "C:\\work & stuff\\O'Brien"
  await openSystemTerminal(cwd, { command: 'C:\\tools\\opencode.exe', args: ['auth', 'login', "literal'$(bad); &"], environment: { HOME: cwd, OPENCODE_CONFIG_CONTENT: '{"value":"$secret"}' } })
  const [command, args] = native.execFile.mock.calls[0]
  expect(command).toBe('wt.exe')
  expect(native.execFile.mock.calls[0][2]).toMatchObject({ cwd, windowsHide: false })
  expect(args.slice(0, 5)).toEqual(['-w', 'new', '-d', cwd, 'powershell.exe'])
  expect(args).toContain('-NoProfile')
  const script = Buffer.from(args.at(-1), 'base64').toString('utf16le')
  expect(script).toContain("Set-Location -LiteralPath 'C:\\work & stuff\\O''Brien'")
  expect(script).toContain('Get-ChildItem Env: | Remove-Item')
  expect(script).toContain("'literal''$(bad); &'")
  expect(script).toContain("'{\"value\":\"$secret\"}'")
  expect(native.spawn).not.toHaveBeenCalled()
})

test('Windows falls back to a new interactive PowerShell window with the same workspace command', async () => {
  platform('win32')
  native.execFile.mockImplementationOnce((_command, _args, _options, callback) => callback(new Error('wt unavailable')))
  const cwd = "C:\\work & stuff\\O'Brien"
  await openSystemTerminal(cwd, { command: 'C:\\tools\\opencode.exe', args: ['auth', 'login'], environment: { HOME: cwd } })
  const encoded = native.execFile.mock.calls[0][1].at(-1)
  expect(native.execFile.mock.calls[1]).toEqual(['powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile -NoExit -EncodedCommand ${encoded}' -WorkingDirectory 'C:\\work & stuff\\O''Brien' -WindowStyle Normal -ErrorAction Stop`
  ], expect.objectContaining({ cwd, windowsHide: true }), expect.any(Function)])
  expect(native.spawn).not.toHaveBeenCalled()
})

test('Windows folder terminals use the visible fallback and report launch failures', async () => {
  platform('win32')
  native.execFile.mockImplementationOnce((_command, _args, _options, callback) => callback(new Error('wt unavailable')))
  await openSystemTerminal('C:\\project')
  const encoded = native.execFile.mock.calls[0][1].at(-1)
  expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe("Set-Location -LiteralPath 'C:\\project'")
  expect(native.execFile.mock.calls[1][1].at(-1)).toContain('-WindowStyle Normal -ErrorAction Stop')
  native.execFile.mockImplementation((_command, _args, _options, callback) => callback(new Error('terminal unavailable')))
  await expect(openSystemTerminal('C:\\project')).rejects.toThrow('terminal unavailable')
})

test('macOS opens folders directly and quotes auth commands inside AppleScript', async () => {
  platform('darwin')
  await openSystemTerminal('/tmp/project')
  expect(native.execFile.mock.calls[0].slice(0, 2)).toEqual(['open', ['-a', 'Terminal', '/tmp/project']])
  await openSystemTerminal("/tmp/it's a project", { command: '/opt/opencode', args: ['auth', 'login'], environment: { HOME: '/tmp/profile', VALUE: 'literal\n"$()`' } })
  const [command, args] = native.execFile.mock.calls[1]
  expect(command).toBe('osascript')
  const script = JSON.parse(args[1].split('do script ')[1].split('\nend tell')[0])
  expect(script).toContain("cd '/tmp/it'\"'\"'s a project'")
  expect(script).toContain("'env' '-i' 'HOME=/tmp/profile'")
  expect(script).toContain("'/opt/opencode' 'auth' 'login'")
})

test('Linux probes installed terminals and preserves the cwd and isolated auth environment', async () => {
  platform('linux')
  native.spawn.mockImplementationOnce(() => {
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })))
    return child
  })
  await openSystemTerminal('/tmp/project', { command: '/opt/opencode', args: ['auth', 'logout'], environment: { HOME: '/tmp/work' } })
  expect(native.spawn.mock.calls.map(([command]) => command)).toEqual(['x-terminal-emulator', 'gnome-terminal'])
  const [, args, options] = native.spawn.mock.calls[1]
  expect(args.slice(0, 4)).toEqual(['--working-directory=/tmp/project', '--', '/bin/sh', '-c'])
  expect(args[4]).toContain("'env' '-i' 'HOME=/tmp/work' '/opt/opencode' 'auth' 'logout'")
  expect(options.cwd).toBe('/tmp/project')
})

test('Linux reports when no supported terminal is available', async () => {
  platform('linux')
  native.spawn.mockImplementation(() => {
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' })))
    return child
  })
  await expect(openSystemTerminal('/tmp/project')).rejects.toThrow('No supported system terminal')
  expect(native.spawn).toHaveBeenCalledTimes(3)
})
