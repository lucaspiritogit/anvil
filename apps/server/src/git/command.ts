import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

interface GitResult {
  stdout: string
  stderr: string
  exitCode: number
}

export async function git(
  cwd: string,
  args: string[],
  acceptedCodes: number[] = [0],
  env?: NodeJS.ProcessEnv
): Promise<GitResult> {
  try {
    const result = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env },
      windowsHide: true,
      maxBuffer: 32 * 1024 * 1024
    })
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string }
    if (typeof failure.code === 'number' && acceptedCodes.includes(failure.code)) {
      return { stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', exitCode: failure.code }
    }
    const detail = (failure.stderr || failure.stdout || failure.message).trim()
    throw new Error(detail || `git ${args[0]} failed`)
  }
}

export function formatGitCommand(args: string[]): string {
  const rendered = args.map((arg) => (/[\s"]/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')
  return `$ git ${rendered}`
}
