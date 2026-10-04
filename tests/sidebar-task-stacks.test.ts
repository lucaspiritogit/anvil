import { expect, test } from 'vitest'
import type { Project, Task, TaskIssueSnapshot } from '@anvil/protocol/types'
import { sidebarTaskStacks } from '../apps/web/src/components/sidebar-task-stacks'
import { sidebarTaskProjects, UNASSIGNED_TASK_GROUP } from '../apps/web/src/components/sidebar-task-projects'

function task(id: string, parentTaskId?: string): Task {
  return {
    id, parentTaskId, workspaceId: 'default', projectId: 'project', title: id,
    prompt: id, agentId: 'codex', agentLabel: 'Codex', cwd: '/tmp',
    status: 'pending', deliveryStatus: 'working', startedAt: 0,
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0,
    costUsd: 0, filesChanged: 0, additions: 0, deletions: 0
  }
}

test('puts nested stack descendants before their parent and marks only the group boundaries', () => {
  const rows = sidebarTaskStacks([task('grandchild', 'child'), task('other'), task('child', 'parent'), task('parent')])
  expect(rows.map((row) => [row.task.id, row.stackStart, row.stackEnd])).toEqual([
    ['grandchild', true, false], ['child', false, false], ['parent', false, true], ['other', false, false]
  ])
})

test('keeps a filtered child visible with stack boundaries when its parent is absent', () => {
  expect(sidebarTaskStacks([task('child', 'hidden')]).map((row) => [row.task.id, row.stackStart, row.stackEnd]))
    .toEqual([['child', true, true]])
})

test('moves a restacking child to its target group', () => {
  const child = task('child', 'old')
  child.restackTarget = { parentTaskId: 'new', branch: 'main', commit: 'abc123' }
  const rows = sidebarTaskStacks([task('old'), task('grandchild', 'child'), child, task('new')])
  expect(rows.map((row) => row.task.id)).toEqual(['old', 'grandchild', 'child', 'new'])
})

test('inserts later siblings at the top of the stack in newest-first order', () => {
  const parent = task('parent')
  const first = { ...task('first', 'parent'), startedAt: 10 }
  const second = { ...task('second', 'parent'), startedAt: 20 }
  const third = { ...task('third', 'parent'), startedAt: 30 }
  const rows = sidebarTaskStacks([third, second, first, parent])
  expect(rows.map((row) => [row.task.id, row.stackStart, row.stackEnd])).toEqual([
    ['third', true, false], ['second', false, false], ['first', false, false], ['parent', false, true]
  ])
})

function project(id: string): Project {
  return { id, name: id, path: `/tmp/${id}`, createdAt: 0, monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' }
}

function projectEntries(overrides: Partial<Parameters<typeof sidebarTaskProjects>[0]> = {}) {
  return sidebarTaskProjects({
    workspaceId: 'default', projects: [project('project')], tasks: [], query: '',
    snapshots: new Map(), taskSeenAt: {}, collapsedProjects: new Set(), expandedSettledGroups: new Set(),
    ...overrides
  })
}

test('shows every project folder and places unassigned tasks after all folders', () => {
  const entries = projectEntries({
    projects: [project('first'), project('empty'), project('last')],
    tasks: [{ ...task('unassigned'), projectId: undefined }, { ...task('last-task'), projectId: 'last' }, { ...task('first-task'), projectId: 'first' }]
  })
  expect(entries.map((entry) => entry.key)).toEqual([
    'project:first', 'first-task', 'project:empty', 'empty:project:empty', 'project:last', 'last-task', 'unassigned'
  ])
  expect(entries.filter((entry) => entry.kind === 'task').map((entry) => [entry.task.id, entry.indented])).toEqual([
    ['first-task', true], ['last-task', true], ['unassigned', false]
  ])
})

test('collapsing a project hides its active and settled tasks while retaining its count', () => {
  const entries = projectEntries({
    tasks: [task('active'), { ...task('settled'), settledAt: 100 }, { ...task('unassigned'), projectId: undefined }],
    collapsedProjects: new Set(['project']), expandedSettledGroups: new Set(['project:project'])
  })
  expect(entries.map((entry) => entry.key)).toEqual(['project:project', 'unassigned'])
  expect(entries[0]).toMatchObject({ kind: 'project', expanded: false, taskCount: 2 })
})

test('settled tasks stay inside their project and can be expanded independently', () => {
  const entries = projectEntries({
    tasks: [{ ...task('older'), settledAt: 100 }, task('active'), { ...task('newer'), settledAt: 200 },
      { ...task('unassigned-settled'), projectId: undefined, settledAt: 300 }],
    expandedSettledGroups: new Set(['project:project'])
  })
  expect(entries.map((entry) => entry.key)).toEqual([
    'project:project', 'active', 'settled:project:project', 'newer', 'older', `settled:${UNASSIGNED_TASK_GROUP}`
  ])
  expect(entries.flatMap((entry) => entry.kind === 'task' && entry.compact ? [entry.task.id] : [])).toEqual(['newer', 'older'])
})

test('a project named like the unassigned group has an independent settled toggle', () => {
  const entries = projectEntries({
    projects: [project(UNASSIGNED_TASK_GROUP)],
    tasks: [{ ...task('project-settled'), projectId: UNASSIGNED_TASK_GROUP, settledAt: 100 },
      { ...task('unassigned-settled'), projectId: undefined, settledAt: 100 }],
    expandedSettledGroups: new Set([`project:${UNASSIGNED_TASK_GROUP}`])
  })
  expect(entries.flatMap((entry) => entry.kind === 'task' ? [entry.task.id] : [])).toEqual(['project-settled'])
})

test('orders tasks by review attention within each project without moving unassigned tasks above folders', () => {
  const entries = projectEntries({ tasks: [task('pending'), { ...task('running'), status: 'running' },
    { ...task('review'), status: 'succeeded', deliveryStatus: 'reviewable' },
    { ...task('unassigned-review'), projectId: undefined, status: 'succeeded', deliveryStatus: 'reviewable' }] })
  expect(entries.map((entry) => entry.key)).toEqual(['project:project', 'review', 'running', 'pending', 'unassigned-review'])
})

test('preserves stack boundaries inside a project folder', () => {
  const entries = projectEntries({ tasks: [task('child', 'parent'), task('other'), task('parent')] })
  expect(entries.filter((entry) => entry.kind === 'task').map((entry) => [entry.task.id, entry.stackStart, entry.stackEnd])).toEqual([
    ['child', true, false], ['parent', false, true], ['other', false, false]
  ])
})

test('search reveals matching active and settled tasks in collapsed folders', () => {
  const snapshot: TaskIssueSnapshot = {
    parent: { id: 'parent', anvilTaskId: 'settled', title: 'Parent', description: '' },
    children: [{ id: 'child', parentId: 'parent', title: 'Repair keyboard navigation', description: '',
      checklist: [], validation: '', labels: [], priority: 'medium', dependencies: [], status: 'complete' }]
  }
  const tasks = [{ ...task('active'), branchName: 'keyboard-controls' }, { ...task('settled'), settledAt: 100 }, task('unrelated')]
  const entries = projectEntries({ tasks, query: 'KEYBOARD', snapshots: new Map([['settled', snapshot]]), collapsedProjects: new Set(['project']) })
  expect(entries.map((entry) => entry.key)).toEqual(['project:project', 'active', 'settled:project:project', 'settled'])
  expect(entries[0]).toMatchObject({ expanded: true, taskCount: 2 })
  expect(entries.find((entry) => entry.kind === 'settled')).toMatchObject({ expanded: true })
  expect(projectEntries({ tasks, collapsedProjects: new Set(['project']) }).map((entry) => entry.key)).toEqual(['project:project'])
})

test('searching a project name includes its tasks and keeps empty folders visible', () => {
  const entries = projectEntries({ projects: [project('project'), project('empty')], tasks: [task('active')], query: 'project' })
  expect(entries.map((entry) => entry.key)).toEqual(['project:project', 'active', 'project:empty'])
})

test('hides tasks from another workspace and retains tasks whose project is unavailable', () => {
  const entries = projectEntries({
    tasks: [{ ...task('other-workspace'), workspaceId: 'other' }, { ...task('missing-project'), projectId: 'missing' }]
  })
  expect(entries.map((entry) => entry.key)).toEqual(['project:project', 'empty:project:project', 'missing-project'])
  expect(entries.at(-1)).toMatchObject({ kind: 'task', indented: false })
})

test('shows an empty workspace and reports searches with no matching tasks', () => {
  expect(projectEntries({ projects: [] })).toEqual([{ kind: 'empty', key: 'empty:workspace', message: 'No tasks yet.', indented: false }])
  expect(projectEntries({ tasks: [task('active')], query: 'missing' }).at(-1)).toMatchObject({ kind: 'empty', message: 'No matching tasks.' })
})
