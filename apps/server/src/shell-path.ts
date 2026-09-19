import { spawn } from 'node:child_process'
import { homedir, userInfo } from 'node:os'

function readLoginShellPath(shell: string, environment: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, [
      '-ilc', '/usr/bin/printf "\\0"; /usr/bin/printenv PATH; /usr/bin/printf "\\0"'
    ], {
      cwd: homedir(),
      env: { ...environment },
      // Interactive zsh can take foreground ownership of the parent's terminal
      // even with piped stdio. Give this temporary shell its own session so
      // Ctrl+C continues to reach the process running Anvil.
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
      killSignal: 'SIGKILL'
    })
    let stdout = ''
    let outputBytes = 0
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      outputBytes += Buffer.byteLength(chunk)
      if (outputBytes > 1024 * 1024) {
        child.kill('SIGKILL')
        reject(new Error('Login shell PATH output exceeded the limit'))
        return
      }
      stdout += chunk
    })
    child.stdout.on('error', reject)
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error('Could not read the login shell PATH'))
        return
      }
      resolve(stdout)
    })
  })
}

/** Finder launches do not inherit the PATH configured by terminal startup files. */
export async function restoreShellPath(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): Promise<void> {
  if (platform !== 'darwin') return

  try {
    const shell = environment.SHELL || userInfo().shell || '/bin/zsh'
    const stdout = await readLoginShellPath(shell, environment)
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
