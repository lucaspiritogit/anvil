import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

interface GitResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface GitIdentity {
  name: string
  email: string
}

export type GitIdentityFallback = (cwd: string) => Promise<GitIdentity | undefined>

const COMMITTING_COMMANDS = new Set(['commit', 'commit-tree', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'stash', 'pull'])
const IDENTITY_VARIABLES = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'] as const
let identityFallback: GitIdentityFallback | undefined

export function setGitIdentityFallback(fallback: GitIdentityFallback | undefined): void {
  identityFallback = fallback
}

function subcommand(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '-c' || args[index] === '-C') index++
    else if (!args[index].startsWith('-')) return args[index]
  }
  return undefined
}

async function identityConfigured(cwd: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const variable of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    try {
      await execFileAsync('git', ['-C', cwd, 'var', variable], { encoding: 'utf8', env, windowsHide: true, timeout: 10_000 })
    } catch {
      return false
    }
  }
  return true
}

async function identityEnvironment(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const fallback = identityFallback
  if (!fallback || !COMMITTING_COMMANDS.has(subcommand(args) ?? '')) return {}
  if (IDENTITY_VARIABLES.every((variable) => env[variable])) return {}
  if (await identityConfigured(cwd, env)) return {}
  const identity = await fallback(cwd).catch(() => undefined)
  if (!identity) return {}
  return {
    GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME || identity.name,
    GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL || identity.email,
    GIT_COMMITTER_NAME: env.GIT_COMMITTER_NAME || identity.name,
    GIT_COMMITTER_EMAIL: env.GIT_COMMITTER_EMAIL || identity.email
  }
}

export async function git(
  cwd: string,
  args: string[],
  acceptedCodes: number[] = [0],
  env?: NodeJS.ProcessEnv
): Promise<GitResult> {
  const base = { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...env }
  try {
    const result = await execFileAsync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      env: { ...base, ...await identityEnvironment(cwd, args, base) },
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
    if (/Author identity unknown|Committer identity unknown|unable to auto-detect email address|empty ident name/.test(detail)) {
      throw new Error('Git has no author name and email for this commit. Connect GitHub in Settings, or run git config --global user.name and user.email on the Anvil server.')
    }
    throw new Error(detail || `git ${args[0]} failed`)
  }
}

export function formatGitCommand(args: string[]): string {
  const rendered = args.map((arg) => (/[\s"]/.test(arg) ? JSON.stringify(arg) : arg)).join(' ')
  return `$ git ${rendered}`
}
