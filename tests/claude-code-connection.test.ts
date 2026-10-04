import { expect, test, vi } from 'vitest'
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { ClaudeCodeConnection, ClaudeControlError, type ClaudeObject } from '../apps/server/src/agents/claude-code-connection'
import { testWorkspace } from './workspace-fixture'
import { onTestCleanup } from './test-cleanup'

function connection(scenario = 'success', diagnostic?: (line: string) => void) {
  const messages: ClaudeObject[] = []
  const workspace = testWorkspace(`claude-connection-${scenario}`)
  const client = new ClaudeCodeConnection({
    workspace, cwd: workspace.home, command: process.execPath,
    args: [resolve('tests/fixtures/claude-code-connection.cjs'), scenario],
    noSessionPersistence: true, safeMode: true, requestTimeoutMs: 2_000,
    mcpServers: [{ name: 'anvil_issue_tracker', url: 'http://localhost:1234/mcp', headers: { Authorization: 'Bearer private-task-capability' }, required: true }]
  }, { message: (message) => messages.push(message), diagnostic })
  onTestCleanup(() => client.close())
  return { client, messages }
}

test('reads structured Claude limits through controls without dispatching user input', async () => {
  const { client, messages } = connection()
  expect(await client.initialize()).toMatchObject({ models: [{ value: 'sonnet' }] })
  const limits = await client.request('get_usage', { skip_behaviors: true })
  expect(limits).toMatchObject({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 12 } } })
  expect(messages).toEqual([])
})

test('native sessions and version probes share the workspace profile with a usable macOS home', async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'global-api-secret')
  vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'global-oauth-secret')
  const observedProfiles: string[] = []
  for (const workspaceId of ['claude-environment-first', 'claude-environment-second']) {
    const workspace = testWorkspace(workspaceId)
    const transcript = join(workspace.home, 'claude-environment.jsonl')
    const client = new ClaudeCodeConnection({
      workspace, cwd: workspace.home, command: process.execPath,
      args: [resolve('tests/fixtures/claude-code-connection.cjs'), 'environment', transcript],
      noSessionPersistence: true, readOnly: true, requestTimeoutMs: 2_000
    }, { message: () => {} })
    onTestCleanup(() => client.close())
    await client.initialize()
    await client.close()
    const launches = (await readFile(transcript, 'utf8')).trim().split('\n').map((line) => JSON.parse(line))
    expect(launches.map((launch) => launch.phase).sort()).toEqual(['connection', 'version'])
    for (const launch of launches) {
      expect(launch.home).toBe(process.platform === 'darwin' ? userInfo().homedir : workspace.home)
      expect(launch.userProfile).toBe(process.platform === 'darwin' ? userInfo().homedir : workspace.home)
      expect(launch.configDir).toBe(workspace.claudeHome)
      expect(launch.globalGit).toBe(process.platform === 'darwin' ? join(workspace.home, '.gitconfig') : undefined)
      expect(launch.apiKey).toBeUndefined()
      expect(launch.oauthToken).toBeUndefined()
    }
    observedProfiles.push(launches[0].configDir)
    expect(workspace.environment.HOME).toBe(workspace.home)
    expect(workspace.environment.GIT_CONFIG_GLOBAL).toBeUndefined()
  }
  expect(new Set(observedProfiles).size).toBe(2)
})

test('distinguishes a Claude control rejection from transport failure', async () => {
  const { client } = connection()
  await client.initialize()
  await expect(client.request('unsupported')).rejects.toBeInstanceOf(ClaudeControlError)
  expect(await client.request('get_usage')).toHaveProperty('rate_limits_available', true)
})

test('rejects unsupported Claude versions before sending an initialization request', async () => {
  const { client, messages } = connection('old')
  await expect(client.initialize()).rejects.toThrow('Update Claude Code to 2.1.288 or later')
  expect(messages).toEqual([])
})

test('fails malformed native output and rejects pending requests', async () => {
  const { client } = connection('invalid')
  await expect(client.initialize()).rejects.toThrow()
  await expect(client.failure).rejects.toThrow()
})

test('bounds unresponsive Claude control requests', async () => {
  const { client } = connection('timeout')
  await client.initialize()
  await expect(client.request('get_usage')).rejects.toThrow('Claude get_usage request timed out')
  await expect(client.request('get_usage')).rejects.toThrow('Claude get_usage request timed out')
})

test('denies unexpected interactive permissions instead of leaving Claude blocked', async () => {
  const { client } = connection()
  await client.initialize()
  expect(await client.request('permission')).toMatchObject({ permission: { behavior: 'deny' } })
})

test('redacts task capabilities from split Claude diagnostics', async () => {
  const lines: string[] = []
  const { client } = connection('success', (line) => lines.push(line))
  await client.initialize()
  await client.request('diagnostic')
  await vi.waitFor(() => expect(lines).toHaveLength(1))
  expect(lines[0]).toBe('Failed header: [redacted]')
})

test.skipIf(process.platform === 'win32')('closing Claude terminates detached tools as well as the CLI', async () => {
  const { client } = connection()
  await client.initialize()
  const child = await client.request('child')
  expect(typeof child.pid).toBe('number')
  await client.close()
  await vi.waitFor(() => expect(() => process.kill(child.pid as number, 0)).toThrow())
})
