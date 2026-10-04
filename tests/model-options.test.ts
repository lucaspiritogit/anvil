import { test, expect } from 'vitest'
import {
  catalogueModelOptions,
  describeModel,
  groupModelsByProvider,
  humanizeModelName,
  modelMatchesQuery,
  normalizeModelSearch
} from '../apps/web/src/model-options'

test('humanizes model slugs from every catalogue without changing their IDs', () => {
  const cases = [
    ['kimi-k3', 'Kimi K3.0'],
    ['deepseek-v4', 'DeepSeek 4.0'],
    ['gpt-5.4-codex', 'GPT 5.4 Codex'],
    ['opencode/kimi-k2.6', 'Kimi K2.6'],
    ['openrouter/anthropic/claude-sonnet-4-6', 'Sonnet 4.6'],
    ['custom-provider/unknown_model+v2.beta', 'Unknown Model V2.beta'],
    ['openrouter/openai/gpt-oss-120b:free', 'GPT OSS 120B Free'],
    ['qwen2.5-coder-32b-instruct', 'Qwen 2.5 Coder 32B Instruct'],
    ['claude-fable-5', 'Fable 5.0'],
    ['claude-fable-5-1', 'Fable 5.1'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ['claude-3-5-sonnet-20241022', 'Sonnet 3.5'],
    ['gpt-6-astra', 'GPT 6.0 Astra'],
    ['gpt-reserve', 'GPT Reserve']
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
  expect(claudeModels.every((model) => model.company === 'Anthropic' && model.name === 'Sonnet 4.6')).toBeTruthy()
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

test('attributes native Claude aliases and resolved models without changing selection IDs', () => {
  for (const id of ['default', 'opus', 'opus[1m]', 'opusplan', 'sonnet', 'sonnet[1m]', 'haiku', 'fable', 'claude-sonnet-4-6']) {
    const model = describeModel(id, 'claude')
    expect(model).toMatchObject({ id, company: 'Anthropic', providerId: 'claude', providerName: 'Claude' })
    expect(modelMatchesQuery(model, 'anthropic')).toBeTruthy()
    expect(modelMatchesQuery(model, 'claude')).toBeTruthy()
  }
  for (const id of ['opus', 'opusplan', 'sonnet[1m]', 'haiku', 'fable']) {
    expect(describeModel(id, '').company).toBe('Anthropic')
  }
  expect(describeModel('', 'claude').providerName).toBe('')
  expect(describeModel('default', 'opencode').company).toBe('')
})

test('uses provider metadata to display resolved versions and retain meaningful variants', () => {
  expect(describeModel('fable', 'claude', { name: 'Fable', resolvedModel: 'claude-fable-5-1' }))
    .toMatchObject({ id: 'fable', name: 'Fable 5.1' })
  expect(describeModel('default', 'claude', { name: 'Default (recommended)', resolvedModel: 'claude-opus-5-5' }))
    .toMatchObject({ id: 'default', name: 'Opus 5.5' })
  expect(describeModel('opencode/deepseek-flash', 'opencode', { name: 'DeepSeek V4.1 Flash', resolvedModel: 'deepseek-flash' }))
    .toMatchObject({ id: 'opencode/deepseek-flash', name: 'DeepSeek 4.1 Flash' })
  expect(describeModel('gpt-5.6-sol', 'codex', { name: 'GPT-5.6-Sol', resolvedModel: 'gpt-5.6-sol' }).name).toBe('GPT 5.6 Sol')
  expect(describeModel('opencode/kimi-k2.7-code-highspeed', 'opencode', { name: 'Kimi K2.7 Code HighSpeed' }).name)
    .toBe('Kimi K2.7 Code HighSpeed')
  expect(describeModel('opus[1m]', 'claude', { name: 'Opus', resolvedModel: 'claude-opus-5-5' }).name).toBe('Opus 5.5 1M')
  expect(describeModel('sonnet[1m]', 'claude', { name: 'Sonnet (1M context)', resolvedModel: 'claude-sonnet-5-5' }).name)
    .toBe('Sonnet 5.5 1M')
  expect(describeModel('fable', 'claude', { name: 'Fable (50% Off)', resolvedModel: 'claude-fable-5-1' }).name)
    .toBe('Fable 5.1')
  expect(describeModel('opusplan', 'claude', { name: 'Opus Plan Mode', resolvedModel: 'claude-opus-5-5' }).name)
    .toBe('Opus 5.5 Plan Mode')
  expect(describeModel('openrouter/anthropic/claude-fable-5-1:free', 'opencode', { name: 'Claude Fable 5.1 (New)' }).name)
    .toBe('Fable 5.1 Free')
  const resolved = describeModel('fable', 'claude', { resolvedModel: 'claude-fable-5-1' })
  expect(modelMatchesQuery(resolved, 'fable 5.1')).toBe(true)
  expect(modelMatchesQuery(resolved, 'claude-fable-5-1')).toBe(true)
})

test('collapses aliases for the same resolved model while preserving selected IDs, versions and credential routes', () => {
  const catalogue = {
    agentId: 'claude',
    models: ['default', 'opus', 'fable', 'claude-fable-5', 'opus[1m]', 'opusplan'],
    displayByModel: {
      default: { name: 'Default (recommended)', resolvedModel: 'claude-opus-5-5' },
      opus: { name: 'Opus 5.5', resolvedModel: 'claude-opus-5-5' },
      fable: { name: 'Fable 5.1', resolvedModel: 'claude-fable-5-1' },
      'claude-fable-5': { name: 'Fable 5', resolvedModel: 'claude-fable-5' },
      'opus[1m]': { name: 'Opus 5.5', resolvedModel: 'claude-opus-5-5' },
      opusplan: { name: 'Opus Plan Mode', resolvedModel: 'claude-opus-5-5' }
    }
  }
  const options = catalogueModelOptions(catalogue, 'claude', 'opus')
  expect(options.map((option) => [option.id, option.name])).toEqual([
    ['opus', 'Opus 5.5'], ['fable', 'Fable 5.1'], ['claude-fable-5', 'Fable 5.0'], ['opus[1m]', 'Opus 5.5 1M'],
    ['opusplan', 'Opus 5.5 Plan Mode']
  ])
  const routes = catalogueModelOptions({
    agentId: 'opencode', models: ['opencode/claude-fable-5-1', 'openrouter/anthropic/claude-fable-5-1'],
    displayByModel: {
      'opencode/claude-fable-5-1': { resolvedModel: 'claude-fable-5-1' },
      'openrouter/anthropic/claude-fable-5-1': { resolvedModel: 'claude-fable-5-1' }
    }
  }, 'opencode')
  expect(routes.map((option) => option.providerName)).toEqual(['OpenCode Zen', 'OpenRouter'])
  expect(catalogueModelOptions(undefined, 'codex', 'custom-model').map((option) => option.id)).toEqual(['custom-model'])
})
