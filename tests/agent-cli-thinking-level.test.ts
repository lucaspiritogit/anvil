import assert from 'node:assert/strict'
import { buildArgs } from '../src/main/agents/process-manager'

const template = ['run', '--model', '{{model}}', '--effort', '{{thinkingLevel}}', '--session', '{{session}}', '{{prompt}}']

const withEverything = buildArgs(template, 'do it', 'gpt-5', 'sess-1', 'high')
assert.deepEqual(withEverything, ['run', '--model', 'gpt-5', '--effort', 'high', '--session', 'sess-1', 'do it'])

const withoutLevel = buildArgs(template, 'do it', 'gpt-5', 'sess-1')
assert.deepEqual(withoutLevel, ['run', '--model', 'gpt-5', '--session', 'sess-1', 'do it'])

const levelOnly = buildArgs(['--effort', '{{thinkingLevel}}'], 'do it', undefined, undefined, 'xhigh')
assert.deepEqual(levelOnly, ['--effort', 'xhigh'])

const inlineLevel = buildArgs(['--effort={{thinkingLevel}}'], 'do it', undefined, undefined, 'low')
assert.deepEqual(inlineLevel, ['--effort=low'])

const noLevelNoFlag = buildArgs(['{{thinkingLevel}}'], 'do it')
assert.deepEqual(noLevelNoFlag, [])

console.log('Legacy CLI thinking-level substitution tests passed: {{thinkingLevel}} substitutes, drops its flag when unset, and leaves {{prompt}} intact.')
