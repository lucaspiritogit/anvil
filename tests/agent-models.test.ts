import { testWorkspace } from './workspace-fixture'
import { onTestCleanup } from './test-cleanup'
import { test, expect, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseOpenCodeModels, requireOpenCodeImageModel } from '../src/main/agents/opencode-models'
import { openCodeAdapter } from '../src/main/agents/adapters'
import type { AgentDefinition } from '../src/shared/types'

const verboseOutput = [
  'openrouter/deepseek/deepseek-v4',
  JSON.stringify({ id: 'deepseek/deepseek-v4', variants: { high: {}, max: { reasoning: { effort: 'max' } } } }, null, 2),
  'openai/plain',
  JSON.stringify({ id: 'plain' }, null, 2),
  'openai/custom',
  JSON.stringify({ id: 'custom', variants: { default: {}, 'custom-effort': {} } }, null, 2)
].join('\n') + '\n'
const expected = {
  models: ['openrouter/deepseek/deepseek-v4', 'openai/plain', 'openai/custom'],
  reasoningByModel: {
    'openrouter/deepseek/deepseek-v4': { options: [{ id: 'high', label: 'high' }, { id: 'max', label: 'max' }] },
    'openai/plain': { options: [] },
    'openai/custom': { options: [{ id: 'default', label: 'default' }, { id: 'custom-effort', label: 'custom-effort' }] }
  }
}

test('parses verbose model metadata and rejects malformed records', async () => {
  expect(parseOpenCodeModels(verboseOutput)).toStrictEqual(expected)
  expect(parseOpenCodeModels(verboseOutput.replaceAll('\n', '\r\n'))).toStrictEqual(expected)
  expect(parseOpenCodeModels('')).toStrictEqual({ models: [], reasoningByModel: {} })
  for (const malformed of ['provider/model\n', 'provider/model\n{\n', 'provider/model\n{\ninvalid\n}', 'provider/model\n{\n"variants": []\n}']) {
    expect(() => parseOpenCodeModels(malformed)).toThrow()
  }
})

test('retains the complete catalogue and image capabilities when the CLI exits before pipe writes drain', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anvil-model-output-'))
  onTestCleanup(() => rm(directory, { recursive: true, force: true }))
  const fixture = join(directory, 'models.cjs')
  await writeFile(fixture, `#!${process.execPath}
if (process.argv.includes('--version')) { console.log('1.18.25'); process.exit(0) }
const output = ['openai/large', JSON.stringify({ description: 'x'.repeat(2 * 1024 * 1024) }, null, 2),
  'openai/reasoner', JSON.stringify({ variants: { high: {}, max: {} }, capabilities: { input: { image: true } } }, null, 2)].join('\\n') + '\\n'
process.stdout.write(output)
process.exit(0)
`, { mode: 0o755 })
  const agent: AgentDefinition = { id: 'large-catalogue', label: 'Fixture', description: '', command: fixture, args: [] }
  const catalogue = await openCodeAdapter.listModels(agent, testWorkspace())
  expect(catalogue.models).toEqual(['openai/large', 'openai/reasoner'])
  expect(catalogue.reasoningByModel?.['openai/reasoner'].options).toEqual([
    { id: 'high', label: 'high' }, { id: 'max', label: 'max' }
  ])
  await expect(requireOpenCodeImageModel(fixture, ['models', '--verbose'], directory, 'openai/reasoner')).resolves.toBeUndefined()
})

test('discovers adapter models, preserves cached effort metadata and reports failures', async () => {
  vi.resetModules()
  onTestCleanup(() => { vi.resetModules() })
  const { registerAgentAdapter, getAgentAdapter } = await import('../src/main/agents/adapters')
  const { listModels } = await import('../src/main/agents/models')
  const directory = await mkdtemp(join(tmpdir(), 'anvil-models-'))
  try {
    const fixture = join(directory, 'models.cjs')
    await writeFile(fixture, `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log('1.18.25'); process.exit(0) }\nprocess.stdout.write(${JSON.stringify(verboseOutput)})`, { mode: 0o755 })
    const agent: AgentDefinition = {
      id: 'verbose-fixture', label: 'Fixture', description: '', command: fixture, args: [],
      models: { kind: 'adapter', adapterId: 'opencode' }
    }
    const futureCatalogue = { models: ['future'], reasoningByModel: { future: { options: [{ id: 'budget:8192', label: 'Thorough' }], default: 'budget:8192' } } }
    const executor = { execute: async () => { throw new Error('unused') } }
    registerAgentAdapter({ id: 'future', createExecutor: () => executor, listModels: async () => futureCatalogue })
    expect(getAgentAdapter('future').createExecutor(testWorkspace())).toBe(executor)
    expect(await listModels({ ...agent, id: 'future', models: { kind: 'adapter', adapterId: 'future' } }, testWorkspace())).toStrictEqual({ agentId: 'future', ...futureCatalogue })
    expect(() => registerAgentAdapter(getAgentAdapter('future'))).toThrow(/already registered/)
    const unknown = await listModels({ ...agent, id: 'unknown', models: { kind: 'adapter', adapterId: 'unknown' } }, testWorkspace())
    expect(unknown.error!).toMatch(/Unknown agent adapter/)
    expect(unknown.reasoningByModel).toBe(undefined)
    const catalogue = await listModels(agent, testWorkspace())
    expect(catalogue).toStrictEqual({ agentId: agent.id, ...expected })
    await writeFile(fixture, `#!${process.execPath}\nprocess.exit(1)`)
    expect(await listModels(agent, testWorkspace()), 'Cache must retain model effort metadata').toStrictEqual(catalogue)
    const failed = await listModels({ ...agent, id: 'failure-fixture' }, testWorkspace())
    expect(failed.error).toBeTruthy()
    expect(failed.models).toStrictEqual([])
    expect(failed.reasoningByModel).toBe(undefined)
    await writeFile(fixture, `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log('1.18.25'); process.exit(0) }\nprocess.stdout.write(${JSON.stringify(verboseOutput)})`, { mode: 0o755 })
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
    expect(codexError.reasoningByModel).toBe(undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('coalesces concurrent catalogue discovery and reuses reasoning metadata', async () => {
  vi.resetModules()
  onTestCleanup(() => { vi.resetModules() })
  const { registerAgentAdapter } = await import('../src/main/agents/adapters')
  const { listModels } = await import('../src/main/agents/models')
  let respond!: (catalogue: typeof expected) => void
  const discover = vi.fn(() => new Promise<typeof expected>((resolve) => { respond = resolve }))
  registerAgentAdapter({ id: 'coalesced', createExecutor: () => { throw new Error('unused') }, listModels: discover })
  const agent: AgentDefinition = {
    id: 'coalesced', label: 'Coalesced', description: '', command: 'unused', args: [],
    models: { kind: 'adapter', adapterId: 'coalesced' }
  }

  const first = listModels(agent, testWorkspace())
  const second = listModels(agent, testWorkspace())
  expect(second).toBe(first)
  expect(discover).toHaveBeenCalledTimes(1)
  respond(expected)
  const catalogue = await first
  expect(await second).toStrictEqual(catalogue)
  expect(await listModels(agent, testWorkspace())).toStrictEqual(catalogue)
  expect(catalogue.reasoningByModel).toStrictEqual(expected.reasoningByModel)
  expect(discover).toHaveBeenCalledTimes(1)
})
