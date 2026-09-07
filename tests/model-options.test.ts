import assert from 'node:assert/strict'
import { describeModel, groupModelsByProvider } from '../src/renderer/src/model-options'

const claudeModels = [
  'anthropic/claude-sonnet-4-6',
  'opencode/claude-sonnet-4-6',
  'openrouter/anthropic/claude-sonnet-4-6'
].map((model) => describeModel(model, 'opencode'))
assert.ok(claudeModels.every((model) => model.company === 'Anthropic' && model.name === 'Claude Sonnet 4.6'))
assert.deepEqual(claudeModels.map((model) => model.providerName), ['Anthropic', 'OpenCode Zen', 'OpenRouter'])
const go = describeModel('opencode-go/gpt-5.4', 'opencode')
const router = describeModel('openrouter/openai/gpt-5.4', 'opencode')
assert.equal(go.company, 'OpenAI')
assert.equal(router.company, 'OpenAI')
assert.equal(go.providerName, 'OpenCode Go')
assert.equal(router.providerName, 'OpenRouter')
assert.equal(router.id, 'openrouter/openai/gpt-5.4', 'Never strip the credential provider from submitted IDs')
const groups = groupModelsByProvider([...claudeModels, go, router])
assert.deepEqual(groups.map((group) => group.providerId), ['anthropic', 'opencode', 'openrouter', 'opencode-go'])
assert.deepEqual(groups.find((group) => group.providerId === 'openrouter')!.models.map((model) => model.id), [
  'openrouter/anthropic/claude-sonnet-4-6', 'openrouter/openai/gpt-5.4'
])
const free = describeModel('openrouter/nvidia/nemotron-3-ultra-550b-a55b:free', 'opencode')
assert.equal(free.providerName, 'OpenRouter')
assert.equal(free.company, 'NVIDIA')
assert.ok(free.id.endsWith(':free'))
assert.equal(describeModel('opencode-go/kimi-k2.6', 'opencode').company, 'Moonshot AI')
assert.equal(describeModel('openrouter-other/anthropic/claude-opus-4-6', 'opencode').providerName, 'openrouter-other')
assert.equal(describeModel('opencode/unknown-model', 'opencode').company, '')
assert.equal(describeModel('gpt-5.4', 'codex').providerName, 'Codex')
assert.equal(describeModel('', 'opencode').providerName, '')
console.log('Model options passed: creator filters, provider groups, credential labels, and unchanged routed IDs.')
