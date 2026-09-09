import { expect, test } from 'vitest'
import { buildArgs } from '../src/main/agents/process-manager'

test('substitutes reasoning effort and removes unset arguments', () => {
  const template = ['run', '--model', '{{model}}', '--effort', '{{reasoningEffort}}', '--session', '{{session}}', '{{prompt}}']

  const withEverything = buildArgs(template, 'do it', 'gpt-5', 'sess-1', 'high')
  expect(withEverything).toStrictEqual(['run', '--model', 'gpt-5', '--effort', 'high', '--session', 'sess-1', 'do it'])

  const withoutEffort = buildArgs(template, 'do it', 'gpt-5', 'sess-1')
  expect(withoutEffort).toStrictEqual(['run', '--model', 'gpt-5', '--session', 'sess-1', 'do it'])

  const effortOnly = buildArgs(['--effort', '{{reasoningEffort}}'], 'do it', undefined, undefined, 'native-maximum')
  expect(effortOnly).toStrictEqual(['--effort', 'native-maximum'])

  const inlineEffort = buildArgs(['--effort={{reasoningEffort}}'], 'do it', undefined, undefined, 'low')
  expect(inlineEffort).toStrictEqual(['--effort=low'])

  const noEffortNoFlag = buildArgs(['{{reasoningEffort}}'], 'do it')
  expect(noEffortNoFlag).toStrictEqual([])


  expect(buildArgs(['{{thinkingLevel}}'], 'do it', undefined, undefined, 'high'), 'Removed template tokens are not interpreted').toStrictEqual(['{{thinkingLevel}}'])
})
