import { expect, test } from 'vitest'
import type { Task } from '../src/shared/types'
import { sidebarTaskStacks } from '../src/renderer/src/components/sidebar-task-stacks'

function task(id: string, parentTaskId?: string): Task {
  return {
    id, parentTaskId, workspaceId: 'default', projectId: 'project', title: id,
    prompt: id, agentId: 'codex', agentLabel: 'Codex', cwd: '/tmp',
    status: 'pending', deliveryStatus: 'working', startedAt: 0,
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0,
    costUsd: 0, filesChanged: 0, additions: 0, deletions: 0
  }
}

test('keeps nested stacks after their parent and marks only the group boundaries', () => {
  const rows = sidebarTaskStacks([task('grandchild', 'child'), task('other'), task('child', 'parent'), task('parent')])
  expect(rows.map((row) => [row.task.id, row.stackStart, row.stackEnd])).toEqual([
    ['parent', true, false], ['child', false, false], ['grandchild', false, true], ['other', false, false]
  ])
})

test('keeps a filtered child visible with stack boundaries when its parent is absent', () => {
  expect(sidebarTaskStacks([task('child', 'hidden')]).map((row) => [row.task.id, row.stackStart, row.stackEnd]))
    .toEqual([['child', true, true]])
})

test('moves a restacking child to its target group', () => {
  const child = task('child', 'old')
  child.restackTarget = { parentTaskId: 'new', branch: 'main', commit: 'abc123' }
  const rows = sidebarTaskStacks([task('old'), child, task('new')])
  expect(rows.map((row) => row.task.id)).toEqual(['old', 'new', 'child'])
})

test('keeps the first child at the top when later children join the same stack', () => {
  const parent = task('parent')
  const first = { ...task('first', 'parent'), startedAt: 10 }
  const second = { ...task('second', 'parent'), startedAt: 20 }
  const third = { ...task('third', 'parent'), startedAt: 30 }
  const rows = sidebarTaskStacks([third, second, first, parent])
  expect(rows.map((row) => row.task.id)).toEqual(['parent', 'first', 'second', 'third'])
})
