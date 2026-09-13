import type { ProviderListResponse } from '@opencode-ai/sdk/client'
import { expect, test, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openCodeModelCatalogue, requireOpenCodeImageModel } from '../src/server/agents/opencode-models'
import type { AgentDefinition, ProviderModelList } from '../src/shared/types'
import { testWorkspace } from './workspace-fixture'
import { onTestCleanup } from './test-cleanup'

const expected = {
  models: ['openrouter/deepseek/deepseek-v4', 'openai/plain', 'openai/custom'],
  reasoningByModel: {
    'openrouter/deepseek/deepseek-v4': { options: [{ id: 'high', label: 'high' }, { id: 'max', label: 'max' }] },
    'openai/plain': { options: [] },
    'openai/custom': { options: [{ id: 'default', label: 'default' }, { id: 'custom-effort', label: 'custom-effort' }] }
  },
  capabilitiesByModel: {
    'openrouter/deepseek/deepseek-v4': { imageInput: true },
    'openai/plain': { imageInput: false },
    'openai/custom': { imageInput: true }
  }
}

test('normalizes SDK model metadata for reasoning and image validation', () => {
  const providers = {
    all: [
      { id: 'openrouter', models: {
        'deepseek/deepseek-v4': { id: 'deepseek/deepseek-v4', variants: { high: {}, max: {} }, capabilities: { input: { image: true } } }
      } },
      { id: 'openai', models: {
        plain: { id: 'plain', variants: {}, capabilities: { input: { image: false } } },
        custom: { id: 'custom', variants: { default: {}, 'custom-effort': {} }, modalities: { input: ['text', 'image'] } }
      } }
    ],
    default: {},
    connected: []
  } as unknown as ProviderListResponse
  const catalogue = openCodeModelCatalogue(providers)
  expect(catalogue).toStrictEqual(expected)
  expect(() => requireOpenCodeImageModel({ agentId: 'opencode', ...catalogue }, 'openai/custom')).not.toThrow()
  expect(() => requireOpenCodeImageModel({ agentId: 'opencode', ...catalogue }, 'openai/plain')).toThrow(/does not advertise image input/)
})

test('discovers adapter models, preserves cached metadata and reports failures', async () => {
  vi.resetModules()
  onTestCleanup(() => { vi.resetModules() })
  const { registerAgentAdapter, getAgentAdapter } = await import('../src/server/agents/adapters')
  const { listModels } = await import('../src/server/agents/models')
  const directory = await mkdtemp(join(tmpdir(), 'anvil-models-'))
  try {
    const agent: AgentDefinition = {
      id: 'catalogue-fixture', label: 'Fixture', description: '', command: 'unused', args: [],
      models: { kind: 'adapter', adapterId: 'catalogue-fixture' }
    }
    const futureCatalogue = { models: ['future'], reasoningByModel: { future: { options: [{ id: 'budget:8192', label: 'Thorough' }], default: 'budget:8192' } } }
    const executor = { execute: async () => { throw new Error('unused') } }
    let discoveryFailure = false
    registerAgentAdapter({ id: 'future', createExecutor: () => executor, listModels: async () => futureCatalogue })
    registerAgentAdapter({
      id: 'catalogue-fixture',
      createExecutor: () => executor,
      listModels: async () => {
        if (discoveryFailure) throw new Error('Discovery unavailable')
        return expected
      }
    })
    expect(getAgentAdapter('future').createExecutor(testWorkspace())).toBe(executor)
    expect(await listModels({ ...agent, id: 'future', models: { kind: 'adapter', adapterId: 'future' } }, testWorkspace())).toStrictEqual({ agentId: 'future', ...futureCatalogue })
    expect(() => registerAgentAdapter(getAgentAdapter('future'))).toThrow(/already registered/)
    const unknown = await listModels({ ...agent, id: 'unknown', models: { kind: 'adapter', adapterId: 'unknown' } }, testWorkspace())
    expect(unknown.error!).toMatch(/Unknown agent adapter/)
    expect(unknown.reasoningByModel).toBeUndefined()
    const catalogue = await listModels(agent, testWorkspace())
    expect(catalogue).toStrictEqual({ agentId: agent.id, ...expected })
    discoveryFailure = true
    expect(await listModels(agent, testWorkspace()), 'Cache must retain model metadata').toStrictEqual(catalogue)
    const failed = await listModels({ ...agent, id: 'failure-fixture' }, testWorkspace())
    expect(failed.error).toMatch(/Discovery unavailable/)
    expect(failed.models).toStrictEqual([])
    expect(failed.reasoningByModel).toBeUndefined()
    discoveryFailure = false
    expect(await listModels({ ...agent, id: 'failure-fixture' }, testWorkspace()), 'Failures are not cached').toStrictEqual({ agentId: 'failure-fixture', ...expected })
    expect(await listModels({ ...agent, id: 'static-fixture', models: { kind: 'static', models: ['gpt-5'] } }, testWorkspace())).toStrictEqual({
      agentId: 'static-fixture', models: ['gpt-5']
    })
    const codex = { ...agent, id: 'codex-fixture', command: process.execPath, args: [join(process.cwd(), 'tests/fixtures/codex-app-server.cjs'), 'models', join(directory, 'codex.jsonl')], models: { kind: 'adapter' as const, adapterId: 'codex' } }
    const codexModels = await listModels(codex, testWorkspace())
    expect(codexModels.models).toStrictEqual(['reasoner', 'plain'])
    expect(codexModels.reasoningByModel?.reasoner.default).toBe('native-max')
    expect(codexModels.reasoningByModel?.plain.options).toStrictEqual([])
    const codexError = await listModels({ ...codex, id: 'codex-error', args: [codex.args[0], 'models-error', codex.args[2]] }, testWorkspace())
    expect(codexError.error!).toMatch(/Discovery unavailable/)
    expect(codexError.reasoningByModel).toBeUndefined()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('coalesces concurrent catalogue discovery and reuses reasoning metadata', async () => {
  vi.resetModules()
  onTestCleanup(() => { vi.resetModules() })
  const { registerAgentAdapter } = await import('../src/server/agents/adapters')
  const { listModels } = await import('../src/server/agents/models')
  let respond!: (catalogue: ProviderModelList) => void
  const discover = vi.fn(() => new Promise<ProviderModelList>((resolve) => { respond = resolve }))
  registerAgentAdapter({ id: 'coalesced', createExecutor: () => { throw new Error('unused') }, listModels: discover })
  const agent: AgentDefinition = {
    id: 'coalesced', label: 'Coalesced', description: '', command: 'unused', args: [],
    models: { kind: 'adapter', adapterId: 'coalesced' }
  }

  const first = listModels(agent, testWorkspace())
  const second = listModels(agent, testWorkspace())
  expect(second).toBe(first)
  expect(discover).toHaveBeenCalledTimes(1)
  respond({ agentId: 'coalesced', ...expected })
  const catalogue = await first
  expect(await second).toStrictEqual(catalogue)
  expect(await listModels(agent, testWorkspace())).toStrictEqual(catalogue)
  expect(catalogue.reasoningByModel).toStrictEqual(expected.reasoningByModel)
  expect(discover).toHaveBeenCalledTimes(1)
})
