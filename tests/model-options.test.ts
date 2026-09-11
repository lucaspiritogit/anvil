import { test, expect } from 'vitest'
import { describeModel, groupModelsByProvider } from '../src/client/renderer/src/model-options'

test('groups routed models by credential provider and retains submitted IDs', () => {
  const claudeModels = [
    'anthropic/claude-sonnet-4-6',
    'opencode/claude-sonnet-4-6',
    'openrouter/anthropic/claude-sonnet-4-6'
  ].map((model) => describeModel(model, 'opencode'))
  expect(claudeModels.every((model) => model.company === 'Anthropic' && model.name === 'Claude Sonnet 4.6')).toBeTruthy()
  expect(claudeModels.map((model) => model.providerName)).toStrictEqual(['Anthropic', 'OpenCode Zen', 'OpenRouter'])
  const go = describeModel('opencode-go/gpt-5.4', 'opencode')
  const router = describeModel('openrouter/openai/gpt-5.4', 'opencode')
  expect(go.company).toBe('OpenAI')
  expect(router.company).toBe('OpenAI')
  expect(go.providerName).toBe('OpenCode Go')
  expect(router.providerName).toBe('OpenRouter')
  expect(router.id, 'Never strip the credential provider from submitted IDs').toBe('openrouter/openai/gpt-5.4')
  const groups = groupModelsByProvider([...claudeModels, go, router])
  expect(groups.map((group) => group.providerId)).toStrictEqual(['anthropic', 'opencode', 'openrouter', 'opencode-go'])
  expect(groups.find((group) => group.providerId === 'openrouter')!.models.map((model) => model.id)).toStrictEqual([
    'openrouter/anthropic/claude-sonnet-4-6', 'openrouter/openai/gpt-5.4'
  ])
})

test('labels free, unknown and provider-specific models', async () => {
  const free = describeModel('openrouter/nvidia/nemotron-3-ultra-550b-a55b:free', 'opencode')
  expect(free.providerName).toBe('OpenRouter')
  expect(free.company).toBe('NVIDIA')
  expect(free.id.endsWith(':free')).toBeTruthy()
  expect(describeModel('opencode-go/kimi-k2.6', 'opencode').company).toBe('Moonshot AI')
  expect(describeModel('openrouter-other/anthropic/claude-opus-4-6', 'opencode').providerName).toBe('openrouter-other')
  expect(describeModel('opencode/unknown-model', 'opencode').company).toBe('')
  expect(describeModel('gpt-5.4', 'codex').providerName).toBe('Codex')
  expect(describeModel('', 'opencode').providerName).toBe('')
})
