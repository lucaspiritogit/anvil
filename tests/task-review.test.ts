import { expect, test } from 'vitest'
import type { Task } from '../src/shared/types'
import { isTaskFinishedUnseen, taskAttentionRank, taskNeedsReview } from '../src/shared/task-review'

const makeTask = (patch: Partial<Task> = {}): Task => ({
  workspaceId: 'default', id: 'task', projectId: 'project', title: 'task', prompt: 'task',
  agentId: 'codex', agentLabel: 'Codex', cwd: '/tmp/project', status: 'succeeded',
  deliveryStatus: 'no_changes', startedAt: 100, endedAt: 200,
  inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: 0,
  filesChanged: 0, additions: 0, deletions: 0,
  ...patch
})

test('finished tasks of any style need review until they are seen', () => {
  for (const style of ['quick', 'work'] as const) {
    const task = makeTask({ style })
    expect(taskNeedsReview(task, undefined)).toBe(true)
    expect(taskNeedsReview(task, 150)).toBe(true)
    expect(taskNeedsReview(task, 250)).toBe(false)
  }
})

test('reviewable delivery keeps the review state even after the task is seen', () => {
  for (const style of ['quick', 'work'] as const) {
    expect(taskNeedsReview(makeTask({ style, deliveryStatus: 'reviewable' }), 250)).toBe(true)
  }
})

test('approved, settled, and unfinished tasks never need review', () => {
  expect(taskNeedsReview(makeTask({ deliveryStatus: 'approved' }), undefined)).toBe(false)
  expect(taskNeedsReview(makeTask({ settledAt: 300 }), undefined)).toBe(false)
  expect(taskNeedsReview(makeTask({ status: 'running', endedAt: undefined }), undefined)).toBe(false)
  expect(taskNeedsReview(makeTask({ status: 'failed' }), undefined)).toBe(false)
})

test('unseen tracking compares against the finish time', () => {
  expect(isTaskFinishedUnseen(makeTask({ endedAt: undefined }), 50)).toBe(true)
  expect(isTaskFinishedUnseen(makeTask({ endedAt: undefined }), 150)).toBe(false)
})

test('attention rank orders review, working, queued, then the rest', () => {
  const review = makeTask({ deliveryStatus: 'reviewable' })
  const running = makeTask({ status: 'running', deliveryStatus: 'working', endedAt: undefined })
  const queued = makeTask({ status: 'pending', deliveryStatus: 'preparing', endedAt: undefined })
  const failed = makeTask({ status: 'failed', deliveryStatus: 'agent_failed' })
  const ranks = [review, running, queued, failed].map((task) => taskAttentionRank(task, undefined))
  expect(ranks).toEqual([0, 1, 2, 3])
  expect(taskAttentionRank(review, 250)).toBe(0)
  expect(taskAttentionRank(makeTask(), 250)).toBe(3)
})
