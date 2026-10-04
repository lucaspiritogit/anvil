import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { claudeWorkspaceEnvironment } from '../apps/server/src/agents/claude-workspace'
import { resolveWorkspaceExecution } from '../apps/server/src/agents/workspace-execution'
import { onTestCleanup } from './test-cleanup'

const native = vi.hoisted(() => ({ userInfo: vi.fn(() => ({ homedir: '/native-home' })) }))
vi.mock('node:os', async () => ({
  ...await vi.importActual<typeof import('node:os')>('node:os'),
  userInfo: native.userInfo
}))

function fixture(inherited: NodeJS.ProcessEnv = process.env) {
  const directory = mkdtempSync(join(tmpdir(), 'anvil-claude-workspace-'))
  onTestCleanup(() => rmSync(directory, { recursive: true, force: true }))
  const store = { getWorkspaceDirectory: (workspaceId: string) => join(directory, 'workspaces', workspaceId) }
  return { directory, workspace: resolveWorkspaceExecution(store, 'work', inherited),
    personal: resolveWorkspaceExecution(store, 'personal', inherited) }
}

test('Claude on macOS uses the OS account home while retaining isolated profiles and filtered credentials', () => {
  native.userInfo.mockReset().mockReturnValue({ homedir: '/native-home' })
  const inherited = {
    PATH: process.env.PATH, HOME: '/overridden-home', USERPROFILE: '/overridden-home',
    ANTHROPIC_API_KEY: 'personal-key', CLAUDE_CODE_OAUTH_TOKEN: 'personal-token', CLAUDE_CONFIG_DIR: '/personal-claude'
  }
  const { workspace, personal } = fixture(inherited)
  const before = { ...workspace.environment }
  const environment = claudeWorkspaceEnvironment(workspace, 'darwin')
  expect(environment).toMatchObject({
    HOME: '/native-home', USERPROFILE: '/native-home', CLAUDE_CONFIG_DIR: workspace.claudeHome,
    GIT_CONFIG_GLOBAL: join(workspace.home, '.gitconfig'), XDG_CONFIG_HOME: workspace.environment.XDG_CONFIG_HOME
  })
  expect(environment.ANTHROPIC_API_KEY).toBeUndefined()
  expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  expect(claudeWorkspaceEnvironment(personal, 'darwin').CLAUDE_CONFIG_DIR).not.toBe(environment.CLAUDE_CONFIG_DIR)
  expect(workspace.environment).toEqual(before)
  expect(workspace.environment.HOME).toBe(workspace.home)
  expect(workspace.environment.GIT_CONFIG_GLOBAL).toBeUndefined()
  expect(inherited.HOME).toBe('/overridden-home')
  expect(Object.isFrozen(environment)).toBe(true)
})

test('Claude on Linux and Windows keeps the workspace home without consulting the OS account', () => {
  native.userInfo.mockReset().mockImplementation(() => { throw new Error('OS account must not be queried') })
  const { workspace } = fixture()
  for (const platform of ['linux', 'win32'] as const) {
    const environment = claudeWorkspaceEnvironment(workspace, platform)
    expect(environment).toEqual(workspace.environment)
    expect(environment.HOME).toBe(workspace.home)
    expect(environment.USERPROFILE).toBe(workspace.home)
    expect(Object.isFrozen(environment)).toBe(true)
  }
  expect(native.userInfo).not.toHaveBeenCalled()
})

test('Claude Git commands keep the workspace author-only configuration despite the restored macOS home', () => {
  const nativeHome = mkdtempSync(join(tmpdir(), 'anvil-claude-native-home-'))
  onTestCleanup(() => rmSync(nativeHome, { recursive: true, force: true }))
  native.userInfo.mockReset().mockReturnValue({ homedir: nativeHome })
  writeFileSync(join(nativeHome, '.gitconfig'), '[user]\nemail = personal@example.test\n[credential]\nhelper = personal-helper\n')
  const seedDirectory = join(nativeHome, 'seed')
  mkdirSync(seedDirectory)
  const seedConfiguration = join(seedDirectory, '.gitconfig')
  writeFileSync(seedConfiguration, '[user]\nname = Workspace Author\nemail = workspace@example.test\n[credential]\nhelper = seed-helper\n')
  const { workspace } = fixture({ ...process.env, GIT_CONFIG_GLOBAL: seedConfiguration })
  const environment = claudeWorkspaceEnvironment(workspace, 'darwin')
  expect(environment.HOME).toBe(nativeHome)
  expect(execFileSync('git', ['config', '--global', '--get', 'user.email'], { env: environment, encoding: 'utf8' }).trim())
    .toBe('workspace@example.test')
  expect(execFileSync('git', ['config', '--global', '--get', 'user.name'], { env: environment, encoding: 'utf8' }).trim())
    .toBe('Workspace Author')
  expect(() => execFileSync('git', ['config', '--global', '--get', 'credential.helper'], { env: environment, stdio: 'pipe' })).toThrow()
})
