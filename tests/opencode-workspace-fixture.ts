import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect } from 'vitest'
import { resolveWorkspaceExecution, type WorkspaceExecutionContext } from '../src/main/agents/workspace-execution'
import { onTestCleanup } from './test-cleanup'

export interface OpenCodeWorkspaceEntry {
  pid: number
  event?: string
  port?: number
  hostname?: string
  method?: string
  args?: string[]
  cwd?: string
  environment?: NodeJS.ProcessEnv
  params?: { cwd?: string }
}

export async function openCodeWorkspaceFixture(): Promise<{
  directory: string
  project: string
  command: string
  work: WorkspaceExecutionContext
  personal: WorkspaceExecutionContext
  entries(workspace: WorkspaceExecutionContext): Promise<OpenCodeWorkspaceEntry[]>
  assertGlobalUnchanged(): Promise<void>
}> {
  const directory = await mkdtemp(join(tmpdir(), 'anvil-opencode-workspaces-'))
  onTestCleanup(() => rm(directory, { recursive: true, force: true }))
  const project = join(directory, 'project')
  await mkdir(join(project, '.git'), { recursive: true })
  await writeFile(join(project, 'AGENTS.md'), 'Keep these repository instructions.\n')
  const globalHome = join(directory, 'global')
  const globalAuth = join(globalHome, '.local/share/opencode/auth.json')
  const globalConfig = join(globalHome, '.config/opencode/opencode.json')
  await mkdir(join(globalHome, '.local/share/opencode'), { recursive: true })
  await mkdir(join(globalHome, '.config/opencode'), { recursive: true })
  const authSentinel = '{"openai":{"type":"api","key":"global-sentinel"}}\n'
  const configSentinel = '{"provider":{"openai":{"options":{"apiKey":"global-config-sentinel"}}}}\n'
  await writeFile(globalAuth, authSentinel)
  await writeFile(globalConfig, configSentinel)
  const inherited = { ...process.env, HOME: globalHome, USERPROFILE: globalHome,
    XDG_DATA_HOME: join(globalHome, '.local/share'), XDG_CONFIG_HOME: join(globalHome, '.config'),
    OPENAI_API_KEY: 'inherited-sentinel', ANTHROPIC_API_KEY: 'inherited-sentinel', AWS_PROFILE: 'global',
    OPENCODE_AUTH_CONTENT: authSentinel, OPENCODE_CONFIG: globalConfig,
    OPENCODE_CONFIG_CONTENT: configSentinel, OPENCODE_CONFIG_DIR: join(globalHome, '.config/opencode'),
    OPENCODE_DB: join(globalHome, 'global.db'), OPENCODE_TEST_HOME: globalHome }
  const store = { getWorkspaceDirectory: (id: string) => join(directory, id) }
  const work = resolveWorkspaceExecution(store, 'work', inherited)
  const personal = resolveWorkspaceExecution(store, 'personal', inherited)
  const command = join(directory, process.platform === 'win32' ? 'opencode.cmd' : 'opencode')
  const fixture = resolve('tests/fixtures/opencode-workspace.cjs')
  await writeFile(command, process.platform === 'win32'
    ? `@echo off\n"${process.execPath}" "${fixture}" %*\n`
    : `#!${process.execPath}\nrequire(${JSON.stringify(fixture)})\n`, { mode: 0o755 })
  return {
    directory, project, command, work, personal,
    async entries(workspace) {
      return (await readFile(join(workspace.home, 'opencode.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as OpenCodeWorkspaceEntry)
    },
    async assertGlobalUnchanged() {
      expect(await readFile(globalAuth, 'utf8')).toBe(authSentinel)
      expect(await readFile(globalConfig, 'utf8')).toBe(configSentinel)
      expect(await readFile(join(project, 'AGENTS.md'), 'utf8')).toBe('Keep these repository instructions.\n')
    }
  }
}
