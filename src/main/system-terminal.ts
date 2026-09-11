import { spawn, execFile } from 'node:child_process'

export interface SystemTerminalCommand {
  command: string
  args: string[]
  environment: NodeJS.ProcessEnv
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`
const powershellQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`
const appleScriptQuote = (value: string): string => JSON.stringify(value)

function launch(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // This window is intentionally interactive and independent of Anvil's lifetime.
    const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 10_000, windowsHide: true }, (error) => error ? reject(error) : resolve())
  })
}

/** Main-owned commands only. Renderer callers supply a project ID, never shell text. */
export async function openSystemTerminal(cwd: string, command?: SystemTerminalCommand): Promise<void> {
  if (process.platform === 'win32') {
    const script = [`Set-Location -LiteralPath ${powershellQuote(cwd)}`]
    if (command) {
      // wt can reuse a server with an unrelated environment. Set the exact workspace
      // environment inside the new shell, without loading a user PowerShell profile.
      script.push('Get-ChildItem Env: | Remove-Item')
      for (const [key, value] of Object.entries(command.environment)) {
        if (value !== undefined) script.push(`[Environment]::SetEnvironmentVariable(${powershellQuote(key)}, ${powershellQuote(value)}, 'Process')`)
      }
      script.push(`& ${[command.command, ...command.args].map(powershellQuote).join(' ')}`)
    }
    const args = ['-NoProfile', '-NoExit', '-EncodedCommand', Buffer.from(script.join('\n'), 'utf16le').toString('base64')]
    try { await run('wt.exe', ['-w', 'new', '-d', cwd, 'powershell.exe', ...args], cwd) }
    catch { await launch('powershell.exe', args, cwd) }
    return
  }

  // Terminal servers can inherit global credentials. env -i restores only the
  // sanitized workspace environment when launching an account command.
  const invocation = command ? ['env', '-i', ...Object.entries(command.environment)
    .flatMap(([key, value]) => value === undefined ? [] : [`${key}=${value}`]), command.command, ...command.args] : undefined
  if (process.platform === 'darwin') {
    if (!invocation) return run('open', ['-a', 'Terminal', cwd], cwd)
    const script = `cd ${shellQuote(cwd)} && ${invocation.map(shellQuote).join(' ')}`
    return run('osascript', ['-e', `tell application "Terminal"\nactivate\ndo script ${appleScriptQuote(script)}\nend tell`], cwd)
  }
  const shell = process.env.SHELL || '/bin/sh'
  const args = invocation ? ['/bin/sh', '-c', `${invocation.map(shellQuote).join(' ')}; printf '\\nPress Enter to close…'; read answer`] : [shell]
  for (const [terminal, options] of [
    ['x-terminal-emulator', ['-e', ...args]],
    ['gnome-terminal', [`--working-directory=${cwd}`, '--', ...args]],
    ['konsole', ['--workdir', cwd, '-e', ...args]]
  ] as const) {
    try { await launch(terminal, [...options], cwd); return }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  throw new Error('No supported system terminal found. Install x-terminal-emulator, gnome-terminal or konsole.')
}
