import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerAgentAdapter, getAgentAdapter } from '../src/main/agents/adapters'
import { listModels } from '../src/main/agents/models'
import { parseOpenCodeModels } from '../src/main/agents/opencode-models'
import type { AgentDefinition } from '../src/shared/types'

const verboseOutput = [
  'openrouter/deepseek/deepseek-v4',
  JSON.stringify({ id: 'deepseek/deepseek-v4', variants: { high: {}, max: { reasoning: { effort: 'max' } } } }, null, 2),
  'provider/plain',
  JSON.stringify({ id: 'plain' }, null, 2),
  'provider/custom',
  JSON.stringify({ id: 'custom', variants: { default: {}, 'custom-effort': {} } }, null, 2)
].join('\n') + '\n'
const expected = {
  models: ['openrouter/deepseek/deepseek-v4', 'provider/plain', 'provider/custom'],
  reasoningByModel: {
    'openrouter/deepseek/deepseek-v4': { options: [{ id: 'high', label: 'high' }, { id: 'max', label: 'max' }] },
    'provider/plain': { options: [] },
    'provider/custom': { options: [{ id: 'default', label: 'default' }, { id: 'custom-effort', label: 'custom-effort' }] }
  }
}

async function main(): Promise<void> {
  assert.deepEqual(parseOpenCodeModels(verboseOutput), expected)
  assert.deepEqual(parseOpenCodeModels(verboseOutput.replaceAll('\n', '\r\n')), expected)
  assert.deepEqual(parseOpenCodeModels(''), { models: [], reasoningByModel: {} })
  for (const malformed of ['provider/model\n', 'provider/model\n{\n', 'provider/model\n{\ninvalid\n}', 'provider/model\n{\n"variants": []\n}']) {
    assert.throws(() => parseOpenCodeModels(malformed))
  }
  const directory = await mkdtemp(join(tmpdir(), 'anvil-models-'))
  try {
    const fixture = join(directory, 'models.cjs')
    await writeFile(fixture, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(verboseOutput)})`, { mode: 0o755 })
    const agent: AgentDefinition = {
      id: 'verbose-fixture', label: 'Fixture', description: '', command: fixture, args: [],
      models: { kind: 'adapter', adapterId: 'opencode' }
    }
    const futureCatalogue = { models: ['future'], reasoningByModel: { future: { options: [{ id: 'budget:8192', label: 'Thorough' }], default: 'budget:8192' } } }
    const executor = { execute: async () => { throw new Error('unused') } }
    registerAgentAdapter({ id: 'future', createExecutor: () => executor, listModels: async () => futureCatalogue })
    assert.equal(getAgentAdapter('future').createExecutor(), executor)
    assert.deepEqual(await listModels({ ...agent, id: 'future', models: { kind: 'adapter', adapterId: 'future' } }), { agentId: 'future', ...futureCatalogue })
    assert.throws(() => registerAgentAdapter(getAgentAdapter('future')), /already registered/)
    const unknown = await listModels({ ...agent, id: 'unknown', models: { kind: 'adapter', adapterId: 'unknown' } })
    assert.match(unknown.error!, /Unknown agent adapter/)
    assert.equal(unknown.reasoningByModel, undefined)
    const catalogue = await listModels(agent)
    assert.deepEqual(catalogue, { agentId: agent.id, ...expected })
    await writeFile(fixture, `#!${process.execPath}\nprocess.exit(1)`)
    assert.deepEqual(await listModels(agent), catalogue, 'Cache must retain model effort metadata')
    const failed = await listModels({ ...agent, id: 'failure-fixture' })
    assert.ok(failed.error)
    assert.deepEqual(failed.models, [])
    assert.equal(failed.reasoningByModel, undefined)
    await writeFile(fixture, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(verboseOutput)})`, { mode: 0o755 })
    assert.deepEqual(await listModels({ ...agent, id: 'failure-fixture' }), { agentId: 'failure-fixture', ...expected }, 'Failures are not cached')
    assert.deepEqual(await listModels({ ...agent, id: 'static-fixture', models: { kind: 'static', models: ['gpt-5'] } }), {
      agentId: 'static-fixture', models: ['gpt-5']
    })
    const codex = { ...agent, id: 'codex-fixture', command: process.execPath, args: [join(process.cwd(), 'tests/fixtures/codex-app-server.cjs'), 'models', join(directory, 'codex.jsonl')], models: { kind: 'adapter' as const, adapterId: 'codex' } }
    const codexModels = await listModels(codex)
    assert.deepEqual(codexModels.models, ['reasoner', 'plain'])
    assert.equal(codexModels.reasoningByModel?.reasoner.default, 'native-max')
    assert.deepEqual(codexModels.reasoningByModel?.plain.options, [])
    const codexError = await listModels({ ...codex, id: 'codex-error', args: [codex.args[0], 'models-error', codex.args[2]] })
    assert.match(codexError.error!, /Discovery unavailable/)
    assert.equal(codexError.reasoningByModel, undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  console.log('Agent model tests passed: verbose metadata, native efforts, missing efforts, malformed output, discovery, and caching.')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
