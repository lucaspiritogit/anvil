import { execFile } from 'node:child_process'
import { homedir, userInfo } from 'node:os'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Finder launches do not inherit the PATH configured by terminal startup files. */
export async function restoreShellPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (platform !== 'darwin') return

  try {
    const shell = environment.SHELL || userInfo().shell || '/bin/zsh'
    const { stdout } = await execFileAsync(shell, [
      '-ilc', '/usr/bin/printf "\\0"; /usr/bin/printenv PATH; /usr/bin/printf "\\0"'
    ], {
      cwd: homedir(),
      env: { ...environment },
      encoding: 'utf8',
      timeout: 5_000,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024
    })
    // Shell plugins can print banners before or after the requested output.
    const shellPath = stdout.split('\0')[1]?.replace(/\r?\n$/, '')
    if (!shellPath || /[\r\n]/.test(shellPath)) throw new Error('Missing shell PATH')
    environment.PATH = [...new Set([
      ...shellPath.split(':'), ...(environment.PATH ?? '').split(':')
    ].filter(Boolean))].join(':')
  } catch {
    // A broken or stalled shell configuration must not prevent Anvil from opening.
    console.warn('Could not load the login shell PATH; using the inherited PATH.')
  }
}
