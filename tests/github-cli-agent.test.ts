import { expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { githubCliAgentEnvironment } from '../apps/server/src/github-cli'
import { resolveWorkspaceExecution, setWorkspaceCredentialEnvironment } from '../apps/server/src/agents/workspace-execution'
import { onTestCleanup } from './test-cleanup'

function directory(): string {
  const path = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-github-cli-agent-')))
  onTestCleanup(() => rmSync(path, { recursive: true, force: true }))
  return path
}

test.skipIf(process.platform === 'win32')('agent Git asks the gh command for GitHub credentials without a token in the environment', () => {
  const root = directory()
  const bin = join(root, 'bin')
  const home = join(root, 'agent-home')
  mkdirSync(bin)
  mkdirSync(home)
  const record = join(root, 'gh-calls')
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$* $GH_CONFIG_DIR" >> "${record}"\ncat > /dev/null\necho username=x-access-token\necho password=from-gh\n`)
  chmodSync(join(bin, 'gh'), 0o755)
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Agent\n')
  const environment = githubCliAgentEnvironment({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1/bus', TOKEN_IGNORED: 'x' }, '/host/home', 'linux')

  expect(environment).toEqual({
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1/bus',
    GH_CONFIG_DIR: '/host/home/.config/gh',
    GH_PROMPT_DISABLED: '1',
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: '!gh auth git-credential'
  })
  const fill = (host: string): string => execFileSync('git', ['credential', 'fill'], {
    env: { PATH: `${bin}${delimiter}${process.env.PATH}`, HOME: home, GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '', ...environment },
    input: `protocol=https\nhost=${host}\n\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore']
  })
  expect(fill('github.com')).toContain('username=x-access-token\npassword=from-gh')
  expect(readFileSync(record, 'utf8').trim()).toBe('auth git-credential get /host/home/.config/gh')
  expect(() => fill('gitlab.com')).toThrow()
})

test('the gh config directory follows GH_CONFIG_DIR, XDG_CONFIG_HOME and the Windows default', () => {
  expect(githubCliAgentEnvironment({ GH_CONFIG_DIR: '/custom/gh' }, '/home/user', 'linux').GH_CONFIG_DIR).toBe('/custom/gh')
  expect(githubCliAgentEnvironment({ XDG_CONFIG_HOME: '/xdg' }, '/home/user', 'linux').GH_CONFIG_DIR).toBe(join('/xdg', 'gh'))
  expect(githubCliAgentEnvironment({ APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, 'C:\\Users\\me', 'win32').GH_CONFIG_DIR)
    .toBe(join('C:\\Users\\me\\AppData\\Roaming', 'GitHub CLI'))
})

test('workspace environments include the gh credential setup when the runtime enables it', () => {
  const workspaceDirectory = join(directory(), 'workspaces', 'default')
  setWorkspaceCredentialEnvironment(() => githubCliAgentEnvironment({}, '/host/home', 'linux'))
  onTestCleanup(() => setWorkspaceCredentialEnvironment(undefined))
  const workspace = resolveWorkspaceExecution({ getWorkspaceDirectory: () => workspaceDirectory }, 'default', { PATH: process.env.PATH })
  expect(workspace.environment).toMatchObject({ GH_CONFIG_DIR: '/host/home/.config/gh', GIT_CONFIG_VALUE_1: '!gh auth git-credential', HOME: join(workspaceDirectory, 'home') })
  expect(Object.keys(workspace.environment).filter((key) => /TOKEN|CREDENTIAL/.test(key))).toEqual([])
})
