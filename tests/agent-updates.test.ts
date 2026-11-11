import { expect, test, vi } from 'vitest'
import type { AgentUpdateState } from '@anvil/protocol/agent-updates'
import { createAgentUpdates, installedAgentVersion } from '../apps/server/src/agents/agent-updates'

function registry(versions: Record<string, string>) {
  return vi.fn(async (url: string) => {
    const name = Object.keys(versions).find((entry) => url.endsWith(`/${entry}/latest`))
    return name ? new Response(JSON.stringify({ version: versions[name] })) : new Response('', { status: 404 })
  })
}

async function settled(changes: AgentUpdateState[][], agentId: string): Promise<AgentUpdateState> {
  await vi.waitFor(() => expect(changes.at(-1)?.find((entry) => entry.agentId === agentId)?.updating).toBe(false))
  return changes.at(-1)!.find((entry) => entry.agentId === agentId)!
}

test('reads the version each agent prints', () => {
  expect(installedAgentVersion('codex-cli 0.157.1\n')).toBe('0.157.1')
  expect(installedAgentVersion('2.1.319 (Claude Code)\n')).toBe('2.1.319')
  expect(installedAgentVersion('unknown')).toBeNull()
})

test('reports newer agent releases, skips missing agents and caches the check', async () => {
  const run = vi.fn(async (command: string) => command === 'claude' ? '2.1.319 (Claude Code)' : null)
  const fetch = registry({ '@anthropic-ai/claude-code': '2.1.322', '@openai/codex': '0.158.0' })
  const updates = createAgentUpdates({ run, fetch })
  const states = await updates.check()
  expect(states.find((entry) => entry.agentId === 'claude')).toMatchObject({ label: 'Claude Code', installed: true, currentVersion: '2.1.319', latestVersion: '2.1.322', available: true })
  expect(states.find((entry) => entry.agentId === 'codex')).toMatchObject({ installed: false, available: false })
  await updates.check()
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(() => updates.install('codex')).toThrow('Codex is not installed')
})

test('runs the agent updater and reports the new version', async () => {
  let version = '0.157.1'
  const run = vi.fn(async (command: string, args: string[]) => {
    if (command !== 'codex') return null
    if (args[0] === 'update') version = '0.158.0'
    return `codex-cli ${version}`
  })
  const changes: AgentUpdateState[][] = []
  const onUpdated = vi.fn()
  const updates = createAgentUpdates({ run, fetch: registry({ '@openai/codex': '0.158.0' }), onChange: (states) => changes.push(states), onUpdated })
  await updates.check()
  expect(updates.install('codex').find((entry) => entry.agentId === 'codex')).toMatchObject({ updating: true })
  expect(await settled(changes, 'codex')).toMatchObject({ currentVersion: '0.158.0', available: false, error: null })
  expect(run).toHaveBeenCalledWith('codex', ['update'], expect.any(Number))
  expect(onUpdated).toHaveBeenCalledWith('codex')
})

test('keeps the notice with the failure when the updater fails', async () => {
  const run = vi.fn(async (_command: string, args: string[]) => {
    if (args[0] === 'update') throw new Error('permission denied')
    return '2.1.319 (Claude Code)'
  })
  const changes: AgentUpdateState[][] = []
  const updates = createAgentUpdates({ run, fetch: registry({ '@anthropic-ai/claude-code': '2.1.322' }), onChange: (states) => changes.push(states) })
  await updates.check()
  updates.install('claude')
  await vi.waitFor(() => expect(updates.state().find((entry) => entry.agentId === 'claude')).toMatchObject({ updating: false, available: true, error: 'permission denied' }))
})

test('stops offering a release the updater does not install', async () => {
  const run = vi.fn(async () => '2.1.319 (Claude Code)')
  const updates = createAgentUpdates({ run, fetch: registry({ '@anthropic-ai/claude-code': '2.1.322' }) })
  await updates.check()
  updates.install('claude')
  await vi.waitFor(() => expect(updates.state().find((entry) => entry.agentId === 'claude')).toMatchObject({ updating: false, available: false, error: null }))
  expect((await updates.check(true)).find((entry) => entry.agentId === 'claude')).toMatchObject({ available: false })
})
