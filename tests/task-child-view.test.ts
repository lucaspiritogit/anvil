import { expect, test } from 'vitest'
import { mergeIssueEvents } from '../src/renderer/src/state/issue-events'
import type { TaskEvent } from '../src/shared/types'

const event = (id: string, issueId?: string, text = id, taskId = 'task'): TaskEvent => ({
  id, issueId, text, taskId, ts: 0, stream: 'stdout', kind: 'output', category: 'message'
})

test('child history excludes parent, siblings, legacy output and other tasks', () => {
  const saved = [event('parent'), event('child', 'child'), event('sibling', 'sibling'), event('foreign', 'child', '', 'other')]
  expect(mergeIssueEvents('task', 'child', saved, [])).toEqual([event('child', 'child')])
  expect(mergeIssueEvents('task', 'queued', saved, [])).toEqual([])
})

test('live events survive a delayed history read and replace persisted tool snapshots', () => {
  expect(mergeIssueEvents('task', 'child', [event('tool', 'child', 'old')], [
    event('tool', 'child', 'new'), event('next', 'child')
  ])).toEqual([event('tool', 'child', 'new'), event('next', 'child')])
})
