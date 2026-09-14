import { test, expect } from 'vitest'
import {
  describeModel,
  groupModelsByProvider,
  humanizeModelName,
  modelMatchesQuery,
  normalizeModelSearch
} from '../src/client/renderer/src/model-options'

test('humanizes model slugs from every catalogue without changing their IDs', () => {
  const cases = [
    ['kimi-k3', 'Kimi K3'],
    ['deepseek-v4', 'Deepseek V4'],
    ['gpt-5.4-codex', 'GPT 5 4 Codex'],
    ['opencode/kimi-k2.6', 'Kimi K2 6'],
    ['openrouter/anthropic/claude-sonnet-4-6', 'Claude Sonnet 4 6'],
    ['custom-provider/unknown_model+v2.beta', 'Unknown Model V2 Beta'],
    ['openrouter/openai/gpt-oss-120b:free', 'GPT Oss 120b Free'],
    ['qwen2.5-coder-32b-instruct', 'Qwen2 5 Coder 32b Instruct']
  ]
  for (const [id, name] of cases) {
    expect(humanizeModelName(id)).toBe(name)
    expect(describeModel(id, 'opencode').id).toBe(id)
  }
})

test('matches compact partial terms across model and provider metadata', () => {
  const kimi = describeModel('openrouter/moonshotai/kimi-k3', 'opencode')
  for (const query of ['kimi', 'K3', 'kimi k3', 'moonshot', 'moonshotai', 'router', 'open-router']) {
    expect(modelMatchesQuery(kimi, query), query).toBeTruthy()
  }
  const deepseek = describeModel('deepseek-v4', 'opencode')
  for (const query of ['deepseek', 'v4', 'deepseek v4', 'deepseek-v4']) {
    expect(modelMatchesQuery(deepseek, query), query).toBeTruthy()
  }
  const codex = describeModel('gpt-5.4-codex', 'codex')
  for (const query of ['GPT', '5.4', '54', 'gpt54', 'codex']) {
    expect(modelMatchesQuery(codex, query), query).toBeTruthy()
  }
  expect(modelMatchesQuery(kimi, 'claude')).toBeFalsy()
  expect(modelMatchesQuery(kimi, '  ')).toBeTruthy()
  expect(normalizeModelSearch('Kimi-K3 / Preview')).toBe('kimik3preview')
})

test('groups routed models by credential provider and retains submitted IDs', () => {
  const claudeModels = [
    'anthropic/claude-sonnet-4-6',
    'opencode/claude-sonnet-4-6',
    'openrouter/anthropic/claude-sonnet-4-6'
  ].map((model) => describeModel(model, 'opencode'))
  expect(claudeModels.every((model) => model.company === 'Anthropic' && model.name === 'Claude Sonnet 4 6')).toBeTruthy()
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
