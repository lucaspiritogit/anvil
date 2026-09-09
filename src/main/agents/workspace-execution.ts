import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Store } from '../store'

/** Main-owned paths and environment, captured before any asynchronous preparation. */
export interface WorkspaceExecutionContext {
  readonly workspaceId: string
  readonly directory: string
  readonly home: string
  readonly codexHome: string
  readonly environment: Readonly<NodeJS.ProcessEnv>
}

// Start with runtime variables, rather than trying to enumerate every provider's
// credentials. In particular, do not inherit API keys, config overrides, cloud
// credential chains, NODE_OPTIONS, or an external agent's session pointers.
const RUNTIME_VARIABLE = /^(PATH|PATHEXT|SYSTEMROOT|SYSTEMDRIVE|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|COLORTERM|USER|USERNAME|LOGNAME|SHELL|SSH_AUTH_SOCK|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|CODEX_CA_CERTIFICATE|OPENCODE_GIT_BASH_PATH|GIT_AUTHOR_NAME|GIT_AUTHOR_EMAIL|GIT_COMMITTER_NAME|GIT_COMMITTER_EMAIL|ANVIL_DATABASE_PATH)$/i

function seedGitIdentity(home: string, inherited: NodeJS.ProcessEnv): void {
  const path = join(home, '.gitconfig')
  if (existsSync(path)) return
  const lines = ['[user]']
  for (const field of ['name', 'email']) {
    try {
      const value = execFileSync('git', ['config', '--global', '--get', `user.${field}`], {
        env: inherited, encoding: 'utf8', timeout: 2_000, maxBuffer: 16_384,
        stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true
      }).trim()
      if (value) lines.push(`\t${field} = ${JSON.stringify(value)}`)
    } catch {
      // Missing global identity is normal; project Git config still takes precedence.
    }
  }
  // Copy only commit attribution. Includes, helpers, signing commands and other
  // global Git configuration must not become credential fallback paths.
  writeFileSync(path, lines.join('\n') + '\n', { flag: 'wx', mode: 0o600 })
}

export function resolveWorkspaceExecution(
  store: Pick<Store, 'getWorkspaceDirectory'>,
  workspaceId: string,
  inherited: NodeJS.ProcessEnv = process.env
): WorkspaceExecutionContext {
  const directory = store.getWorkspaceDirectory(workspaceId)
  const home = join(directory, 'home')
  const codexHome = join(directory, 'codex')
  const environment: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(inherited)) {
    if (RUNTIME_VARIABLE.test(key) && value !== undefined) environment[key] = value
  }
  Object.assign(environment, {
    HOME: home,
    USERPROFILE: home,
    CODEX_HOME: codexHome,
    XDG_CONFIG_HOME: join(directory, 'config'),
    XDG_DATA_HOME: join(directory, 'data'),
    XDG_CACHE_HOME: join(directory, 'cache'),
    XDG_STATE_HOME: join(directory, 'state'),
    APPDATA: join(directory, 'config'),
    LOCALAPPDATA: join(directory, 'data'),
    OPENCODE_DISABLE_AUTOUPDATE: 'true'
  })
  for (const path of [home, codexHome, environment.XDG_CONFIG_HOME!, environment.XDG_DATA_HOME!, environment.XDG_CACHE_HOME!, environment.XDG_STATE_HOME!]) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  seedGitIdentity(home, inherited)
  return Object.freeze({ workspaceId, directory, home, codexHome, environment: Object.freeze(environment) })
}

export function resolveTaskWorkspace(store: Store, taskId: string): WorkspaceExecutionContext {
  const task = store.getTask(taskId)
  if (!task) throw new Error('Task not found')
  return resolveWorkspaceExecution(store, task.workspaceId)
}
