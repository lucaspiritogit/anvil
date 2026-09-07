import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  effortsByModel: {
    'openrouter/deepseek/deepseek-v4': ['high', 'max'],
    'provider/plain': [],
    'provider/custom': ['default', 'custom-effort']
  }
}

async function main(): Promise<void> {
  assert.deepEqual(parseOpenCodeModels(verboseOutput), expected)
  assert.deepEqual(parseOpenCodeModels(verboseOutput.replaceAll('\n', '\r\n')), expected)
  assert.deepEqual(parseOpenCodeModels(''), { models: [], effortsByModel: {} })
  for (const malformed of ['provider/model\n', 'provider/model\n{\n', 'provider/model\n{\ninvalid\n}', 'provider/model\n{\n"variants": []\n}']) {
    assert.throws(() => parseOpenCodeModels(malformed))
  }
  const directory = await mkdtemp(join(tmpdir(), 'anvil-models-'))
  try {
    const fixture = join(directory, 'models.cjs')
    await writeFile(fixture, `process.stdout.write(${JSON.stringify(verboseOutput)})`)
    const agent: AgentDefinition = {
      id: 'verbose-fixture', label: 'Fixture', description: '', command: process.execPath, args: [],
      models: { kind: 'command', command: process.execPath, args: [fixture], format: 'opencode-verbose' }
    }
    const catalogue = await listModels(agent)
    assert.deepEqual(catalogue, { agentId: agent.id, ...expected })
    await writeFile(fixture, 'process.exit(1)')
    assert.deepEqual(await listModels(agent), catalogue, 'Cache must retain model effort metadata')
    const failed = await listModels({ ...agent, id: 'failure-fixture' })
    assert.ok(failed.error)
    assert.deepEqual(failed.models, [])
    await writeFile(fixture, `process.stdout.write(${JSON.stringify(verboseOutput)})`)
    assert.deepEqual(await listModels({ ...agent, id: 'failure-fixture' }), { agentId: 'failure-fixture', ...expected }, 'Failures are not cached')
    assert.deepEqual(await listModels({ ...agent, id: 'static-fixture', models: { kind: 'static', models: ['gpt-5'] } }), {
      agentId: 'static-fixture', models: ['gpt-5']
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  console.log('Agent model tests passed: verbose metadata, native efforts, missing efforts, malformed output, discovery, and caching.')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
