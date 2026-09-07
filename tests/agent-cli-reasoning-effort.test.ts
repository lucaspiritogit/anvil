import assert from 'node:assert/strict'
import { buildArgs } from '../src/main/agents/process-manager'

const template = ['run', '--model', '{{model}}', '--effort', '{{reasoningEffort}}', '--session', '{{session}}', '{{prompt}}']

const withEverything = buildArgs(template, 'do it', 'gpt-5', 'sess-1', 'high')
assert.deepEqual(withEverything, ['run', '--model', 'gpt-5', '--effort', 'high', '--session', 'sess-1', 'do it'])

const withoutEffort = buildArgs(template, 'do it', 'gpt-5', 'sess-1')
assert.deepEqual(withoutEffort, ['run', '--model', 'gpt-5', '--session', 'sess-1', 'do it'])

const effortOnly = buildArgs(['--effort', '{{reasoningEffort}}'], 'do it', undefined, undefined, 'native-maximum')
assert.deepEqual(effortOnly, ['--effort', 'native-maximum'])

const inlineEffort = buildArgs(['--effort={{reasoningEffort}}'], 'do it', undefined, undefined, 'low')
assert.deepEqual(inlineEffort, ['--effort=low'])

const noEffortNoFlag = buildArgs(['{{reasoningEffort}}'], 'do it')
assert.deepEqual(noEffortNoFlag, [])

console.log('Legacy CLI reasoning-effort substitution tests passed: {{reasoningEffort}} substitutes, drops its flag when unset, and leaves {{prompt}} intact.')

assert.deepEqual(buildArgs(['{{thinkingLevel}}'], 'do it', undefined, undefined, 'high'), ['{{thinkingLevel}}'], 'Removed template tokens are not interpreted')
