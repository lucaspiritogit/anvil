import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { openCodeAdapter } from '../apps/server/src/agents/adapters'
import { discoverOpenCodeModels } from '../apps/server/src/agents/opencode-sdk'
import type { WorkspaceExecutionContext } from '../apps/server/src/agents/workspace-execution'
import { openCodeWorkspaceFixture } from './opencode-workspace-fixture'

async function setWorkspaceKey(workspace: WorkspaceExecutionContext, key: string): Promise<void> {
  const path = join(workspace.environment.XDG_DATA_HOME!, 'opencode', 'auth.json')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({ openai: { type: 'api', key } }))
}

async function assertPortReleased(port: number): Promise<void> {
  const server = createServer()
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
  } finally {
    if (server.listening) await new Promise<void>((resolve) => { server.close(() => resolve()) })
  }
}

test('discovers typed SDK models in isolated workspaces and closes each server', async () => {
  const fixture = await openCodeWorkspaceFixture()
  await setWorkspaceKey(fixture.work, 'work-key')
  await setWorkspaceKey(fixture.personal, 'personal-key')
  const agent = { id: 'opencode', label: 'OpenCode', description: '', command: fixture.command, args: [] }

  for (const [workspace, key] of [[fixture.work, 'work-key'], [fixture.personal, 'personal-key']] as const) {
    const catalogue = await openCodeAdapter.listModels(agent, workspace)
    expect(catalogue).toStrictEqual({
      models: [`openai/${key}`],
      reasoningByModel: { [`openai/${key}`]: { options: [{ id: 'high', level: 'high' }] } },
      capabilitiesByModel: { [`openai/${key}`]: { imageInput: true } }
    })
    const entries = await fixture.entries(workspace)
    const spawn = entries.find((entry) => entry.event === 'spawn' && entry.args?.[0] === 'serve')!
    const listening = entries.find((entry) => entry.event === 'sdk-listening')!
    expect(spawn.cwd).toBe(workspace.home)
    expect(spawn.args).toStrictEqual(['serve', '--hostname=127.0.0.1', '--port=0', '--mdns=false'])
    expect(spawn.environment).toMatchObject({
      HOME: workspace.home,
      XDG_DATA_HOME: join(workspace.directory, 'data'),
      XDG_CONFIG_HOME: join(workspace.directory, 'config'),
      XDG_CACHE_HOME: join(workspace.directory, 'cache'),
      XDG_STATE_HOME: join(workspace.directory, 'state'),
      OPENCODE_PURE: 'true'
    })
    expect(JSON.parse(spawn.environment!.OPENCODE_CONFIG_CONTENT!)).toEqual({
      enabled_providers: ['openai', 'anthropic', 'openrouter', 'opencode', 'opencode-go'],
      permission: { external_directory: 'allow' }
    })
    await assertPortReleased(listening.port!)
  }
  await fixture.assertGlobalUnchanged()
})

test('cancels SDK discovery and stops a server that never becomes ready', async () => {
  const fixture = await openCodeWorkspaceFixture()
  const marker = join(fixture.work.home, 'sdk-started')
  const script = join(fixture.directory, 'slow-sdk.cjs')
  const command = join(fixture.directory, process.platform === 'win32' ? 'slow-sdk.cmd' : 'slow-sdk')
  await writeFile(script, `
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(marker)}, String(process.pid))
setInterval(() => {}, 1000)
`)
  await writeFile(command, process.platform === 'win32'
    ? `@echo off\n"${process.execPath}" "${script}" %*\n`
    : `#!${process.execPath}\nrequire(${JSON.stringify(script)})\n`, { mode: 0o755 })
  const controller = new AbortController()
  const result = discoverOpenCodeModels({ id: 'opencode', label: 'OpenCode', description: '', command, args: [] }, fixture.work, controller.signal)
  await vi.waitFor(() => expect(existsSync(marker)).toBe(true))
  const pid = Number(await readFile(marker, 'utf8'))
  controller.abort()
  await expect(result).rejects.toThrow(/abort/i)
  expect(() => process.kill(pid, 0)).toThrow()
})

test('rejects a missing OpenCode executable before starting SDK discovery', async () => {
  const fixture = await openCodeWorkspaceFixture()
  await expect(discoverOpenCodeModels({
    id: 'opencode', label: 'OpenCode', description: '', command: '/anvil-missing-opencode', args: []
  }, fixture.work)).rejects.toThrow('not installed or not on PATH')
})
