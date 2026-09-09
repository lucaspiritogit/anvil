import { expect, test, vi } from 'vitest'
import { existsSync, realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCodeWorkspaceFixture } from './opencode-workspace-fixture'
import { openCodeAdapter } from '../src/main/agents/adapters'
import { requireOpenCodeImageModel } from '../src/main/agents/opencode-models'
import { openCodeWorkspaceCommand, openCodeWorkspaceEnvironment } from '../src/main/agents/opencode-workspace'
import type { WorkspaceExecutionContext } from '../src/main/agents/workspace-execution'
import { readOpenCodeModelOutput, verifyWorkspaceOpenCode } from '../src/main/agents/opencode-model-output'
import { onTestCleanup } from './test-cleanup'

test('preserves project context and rejects failed or oversized model output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anvil-model-context-'))
  onTestCleanup(() => rm(directory, { recursive: true, force: true }))
  const output = await readOpenCodeModelOutput(process.execPath, ['-e', `
    console.log(JSON.stringify({ cwd: process.cwd(), pwd: process.env.PWD, color: process.env.NO_COLOR }))
  `], directory)
  expect(JSON.parse(output)).toEqual({ cwd: realpathSync(directory), pwd: directory, color: '1' })
  await expect(readOpenCodeModelOutput(process.execPath, ['-e', 'process.stderr.write("Discovery unavailable"); process.exit(1)']))
    .rejects.toThrow('Discovery unavailable')
  await expect(readOpenCodeModelOutput(process.execPath, ['-e', 'require("node:fs").writeFileSync(1, Buffer.alloc(33 * 1024 * 1024))']))
    .rejects.toThrow('32 MiB output limit')
})

test('cancels model discovery while the CLI is running', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anvil-model-cancel-'))
  onTestCleanup(() => rm(directory, { recursive: true, force: true }))
  const controller = new AbortController()
  onTestCleanup(() => controller.abort())
  const result = readOpenCodeModelOutput(process.execPath, ['-e', `
    require('node:fs').writeFileSync('ready', '')
    setInterval(() => {}, 1000)
  `], directory, controller.signal)
  const rejected = expect(result).rejects.toThrow(/abort/i)
  await vi.waitFor(() => expect(existsSync(join(directory, 'ready'))).toBe(true))
  controller.abort()
  await rejected
})

test('scopes auth commands, model catalogues and image probes to Work and Personal', async () => {
  const fixture = await openCodeWorkspaceFixture()
  const auth = async (workspace: WorkspaceExecutionContext, args: string[]): Promise<string> => {
    const launch = openCodeWorkspaceCommand(workspace, args)
    return readOpenCodeModelOutput(fixture.command, launch.args, launch.cwd, undefined, launch.environment)
  }
  await auth(fixture.work, ['auth', 'login', 'work-key'])
  await auth(fixture.personal, ['auth', 'login', 'personal-key'])
  const agent = { id: 'opencode', label: 'OpenCode', description: '', command: fixture.command, args: [] }
  for (const [workspace, key] of [[fixture.work, 'work-key'], [fixture.personal, 'personal-key']] as const) {
    const catalogue = await openCodeAdapter.listModels(agent, workspace)
    expect(catalogue.models).toEqual([`openai/${key}`])
    expect(Object.keys(catalogue.reasoningByModel ?? {})).toEqual([`openai/${key}`])
    expect(await auth(workspace, ['auth', 'list'])).toBe('openai\n')
    await expect(requireOpenCodeImageModel(fixture.command, ['models', '--verbose'], fixture.project, `openai/${key}`, undefined, openCodeWorkspaceEnvironment(workspace))).resolves.toBeUndefined()
    const spawns = (await fixture.entries(workspace)).filter((entry) => entry.event === 'spawn')
    expect(spawns.some((entry) => entry.args?.[0] === 'models' && entry.cwd?.endsWith('/project'))).toBe(true)
    for (const spawn of spawns) {
      expect(spawn.environment).toMatchObject({ HOME: workspace.home, XDG_DATA_HOME: join(workspace.directory, 'data'),
        XDG_CONFIG_HOME: join(workspace.directory, 'config'), XDG_CACHE_HOME: join(workspace.directory, 'cache'),
        XDG_STATE_HOME: join(workspace.directory, 'state'), OPENCODE_PURE: 'true' })
      expect(JSON.parse(spawn.environment!.OPENCODE_CONFIG_CONTENT!)).toEqual({ enabled_providers: ['openai', 'anthropic', 'openrouter', 'opencode', 'opencode-go'] })
      for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'AWS_PROFILE', 'OPENCODE_AUTH_CONTENT', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_DB', 'OPENCODE_TEST_HOME']) {
        expect(spawn.environment?.[name], name).toBeUndefined()
      }
    }
  }
  await auth(fixture.work, ['auth', 'logout'])
  expect(await auth(fixture.work, ['auth', 'list'])).toBe('\n')
  expect(await auth(fixture.personal, ['auth', 'list'])).toBe('openai\n')
  await fixture.assertGlobalUnchanged()
})

test('rejects a missing CLI before discovery reads account storage', async () => {
  const fixture = await openCodeWorkspaceFixture()
  await expect(verifyWorkspaceOpenCode('anvil-missing-opencode', fixture.work.home, fixture.work.environment)).rejects.toThrow('not installed or not on PATH')
  expect(existsSync(join(fixture.work.home, 'opencode.jsonl'))).toBe(false)
})
