import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { git } from './git/command'

const execFileAsync = promisify(execFile)
const GITHUB_CREDENTIAL_KEY = 'credential.https://github.com.helper'
const GITHUB_CREDENTIAL_HELPER = '!gh auth git-credential'

let available: Promise<boolean> | undefined

function githubCliAvailable(): Promise<boolean> {
  available ??= execFileAsync('gh', ['--version'], { timeout: 10_000, windowsHide: true }).then(() => true, () => {
    available = undefined
    return false
  })
  return available
}

export async function githubCliToken(): Promise<string | null> {
  if (!(await githubCliAvailable())) return null
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token', '--hostname', 'github.com'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' }
    })
    const token = stdout.trim()
    return token && token.length <= 1024 && !/\s/.test(token) ? token : null
  } catch {
    return null
  }
}

export function withGitHubCliCredentials(env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const merged = { ...process.env, ...env }
  const existing = Number(merged.GIT_CONFIG_COUNT)
  const index = Number.isSafeInteger(existing) && existing > 0 ? existing : 0
  return {
    ...env,
    GIT_CONFIG_COUNT: String(index + 1),
    [`GIT_CONFIG_KEY_${index}`]: GITHUB_CREDENTIAL_KEY,
    [`GIT_CONFIG_VALUE_${index}`]: GITHUB_CREDENTIAL_HELPER
  }
}

export const githubRemoteGit: typeof git = async (cwd, args, acceptedCodes, env) =>
  git(cwd, args, acceptedCodes, (await githubCliAvailable()) ? withGitHubCliCredentials(env) : env)
