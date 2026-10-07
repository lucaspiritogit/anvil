import { expect, test } from 'vitest'
import { structuredPatchEdit, taskEventEditLines, textEdit, unifiedDiffEdit } from '@anvil/protocol/task-event-edits'
import { testWorkspace } from './workspace-fixture'
import { ClaudeCodeOutput } from '../apps/server/src/agents/claude-code-output'
import { CodexAppServerOutput } from '../apps/server/src/agents/codex-app-server-output'
import { AcpOutput } from '../apps/server/src/agents/acp-output'
import type { TaskEvent } from '../apps/server/src/agents/agent-executor'
import type { TaskEvent as OutputEvent } from '@anvil/protocol/types'

const before = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].join('\n')

test('builds numbered hunks with context around each change', () => {
  const edit = textEdit('src/a.ts', before, before.replace('five', 'FIVE').replace('ten', 'TEN\neleven'))
  expect(edit).toMatchObject({ path: 'src/a.ts', additions: 3, deletions: 2 })
  expect(edit.hunks.split('\n')).toEqual([
    '@@ -2,9 +2,10 @@', ' two', ' three', ' four', '-five', '+FIVE', ' six', ' seven', ' eight', ' nine', '-ten', '+TEN', '+eleven'
  ])
  expect(taskEventEditLines(edit).slice(3, 6)).toEqual([
    { kind: 'context', text: 'four', oldLine: 4, newLine: 4 },
    { kind: 'delete', text: 'five', oldLine: 5 },
    { kind: 'add', text: 'FIVE', newLine: 5 }
  ])
})

test('fragments without file positions keep unnumbered hunks', () => {
  const edit = textEdit('src/a.ts', 'const a = 1', 'const a = 2', false)
  expect(edit.hunks).toBe('@@\n-const a = 1\n+const a = 2')
  expect(taskEventEditLines(edit)).toEqual([
    { kind: 'hunk', text: '@@' }, { kind: 'delete', text: 'const a = 1' }, { kind: 'add', text: 'const a = 2' }
  ])
})

test('reads unified diffs and structured patches and caps long hunks', () => {
  expect(unifiedDiffEdit('a.ts', '--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n keep\n')).toEqual({
    path: 'a.ts', additions: 1, deletions: 1, hunks: '@@ -1,2 +1,2 @@\n-old\n+new\n keep'
  })
  expect(structuredPatchEdit('b.ts', [{ oldStart: 4, oldLines: 1, newStart: 4, newLines: 2, lines: [' a', '+b'] }]).hunks).toBe('@@ -4,1 +4,2 @@\n a\n+b')
  const large = textEdit('big.ts', '', Array.from({ length: 450 }, (_, index) => `line ${index}`).join('\n'))
  expect(large).toMatchObject({ additions: 450, deletions: 0, omitted: 51 })
})

function outputEvents(events: TaskEvent[]): OutputEvent[] {
  return [...new Map(events.flatMap((event) => event.type === 'output' ? [[event.event.id, event.event] as const] : [])).values()]
}

test('agent adapters attach file edits to their tool calls', () => {
  const workspace = testWorkspace()
  const input = { workspace, taskId: 'edits', cwd: workspace.home, prompt: '' }

  const claudeEvents: TaskEvent[] = []
  const claude = new ClaudeCodeOutput(input, (event) => { claudeEvents.push(event) })
  claude.message({ type: 'assistant', message: { id: 'edit', content: [{ type: 'tool_use', id: 'edit-1', name: 'Edit', input: { file_path: 'src/a.ts', old_string: 'old', new_string: 'new\nmore' } }] } })
  expect(outputEvents(claudeEvents).find((event) => event.category === 'tool_use')?.edits).toEqual([{ path: 'src/a.ts', additions: 2, deletions: 1, hunks: '@@\n-old\n+new\n+more' }])
  claude.message({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'edit-1', content: 'Updated' }] },
    tool_use_result: { structuredPatch: [{ oldStart: 7, oldLines: 1, newStart: 7, newLines: 2, lines: ['-old', '+new', '+more'] }] }
  })
  expect(outputEvents(claudeEvents).find((event) => event.category === 'tool_use')?.edits?.[0].hunks).toBe('@@ -7,1 +7,2 @@\n-old\n+new\n+more')

  const codexEvents: TaskEvent[] = []
  const codex = new CodexAppServerOutput(input, (event) => { codexEvents.push(event) })
  codex.item({ id: 'patch', type: 'fileChange', status: 'completed', changes: [
    { path: '/repo/a.ts', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b\n' },
    { path: '/repo/new.ts', kind: { type: 'add' }, diff: 'export {}\n' }
  ] }, true)
  codex.flush()
  expect(outputEvents(codexEvents).find((event) => event.category === 'tool_use')?.edits?.map((edit) => [edit.path, edit.additions, edit.deletions]))
    .toEqual([['/repo/a.ts', 1, 1], ['/repo/new.ts', 1, 0]])

  const acpEvents: TaskEvent[] = []
  const acp = new AcpOutput(input, (event) => { acpEvents.push(event) })
  acp.update({ sessionUpdate: 'tool_call', toolCallId: 'edit', title: 'Edit source', kind: 'edit', status: 'completed', locations: [{ path: '/repo/a.ts' }],
    content: [{ type: 'diff', path: '/repo/a.ts', oldText: 'a\nb', newText: 'a\nc' }] })
  acp.flush()
  expect(outputEvents(acpEvents).find((event) => event.category === 'tool_use')?.edits).toEqual([{ path: '/repo/a.ts', additions: 1, deletions: 1, hunks: '@@ -1,2 +1,2 @@\n a\n-b\n+c' }])
})
