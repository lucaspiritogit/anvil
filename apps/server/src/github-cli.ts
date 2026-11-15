import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
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

function githubCliConfigDirectory(inherited: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): string {
  if (inherited.GH_CONFIG_DIR) return inherited.GH_CONFIG_DIR
  if (inherited.XDG_CONFIG_HOME) return join(inherited.XDG_CONFIG_HOME, 'gh')
  if (platform === 'win32' && inherited.APPDATA) return join(inherited.APPDATA, 'GitHub CLI')
  return join(home, '.config', 'gh')
}

export function githubCliAgentEnvironment(
  inherited: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const keyring = Object.fromEntries(['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']
    .flatMap((key) => inherited[key] ? [[key, inherited[key]]] : []))
  return {
    ...keyring,
    GH_CONFIG_DIR: githubCliConfigDirectory(inherited, home, platform),
    GH_PROMPT_DISABLED: '1',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: GITHUB_CREDENTIAL_KEY,
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: GITHUB_CREDENTIAL_KEY,
    GIT_CONFIG_VALUE_1: GITHUB_CREDENTIAL_HELPER
  }
}
