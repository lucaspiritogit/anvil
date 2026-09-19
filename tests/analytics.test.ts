import { expect, test } from 'vitest'
import type { Task, TaskStatus, WorkspaceAnalytics } from '@anvil/protocol/types'
import { createHandlerRegistry } from '../apps/server/src/handler-registry'
import { registerAnalyticsHandlers } from '../apps/server/src/handlers/analytics'
import { Store } from '../apps/server/src/store'
import { migrationsFolder } from './migration-fixture'
import { onTestCleanup } from './test-cleanup'

function fixture() {
  const store = new Store(':memory:', { migrationsFolder })
  const ipc = createHandlerRegistry()
  registerAnalyticsHandlers(ipc, store)
  onTestCleanup(() => store.close())
  return {
    store,
    analytics: (startAt: number, endAt: number) => ipc.invoke('analytics:get', { startAt, endAt }) as WorkspaceAnalytics
  }
}

function addProject(store: Store, id: string, name = id): void {
  store.addProject({
    id,
    name,
    path: `/test/${id}`,
    createdAt: 0,
    monthlyTokenLimit: null,
    monthlyCostLimitUsd: null,
    finishOnPush: false,
    gitPlatform: 'github'
  })
}

function addTask(store: Store, input: {
  id: string
  projectId?: string
  status?: TaskStatus
  startedAt: number
  agentId?: string
  agentLabel?: string
  model?: string
  inputTokens?: number
  outputTokens?: number
  cachedTokens?: number
  totalTokens?: number
  costUsd?: number | null
  workingTimeMs?: number
  filesChanged?: number
  additions?: number
  deletions?: number
}): void {
  const task: Omit<Task, 'workspaceId'> = {
    id: input.id,
    projectId: input.projectId ?? 'project-a',
    agentId: input.agentId ?? 'codex',
    agentLabel: input.agentLabel ?? 'Codex',
    ...(input.model === undefined ? {} : { model: input.model }),
    prompt: 'Analyze',
    title: input.id,
    cwd: '/test',
    status: input.status ?? 'succeeded',
    startedAt: input.startedAt,
    workingTimeMs: input.workingTimeMs ?? 0,
    exitCode: null,
    deliveryStatus: 'reviewable',
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    cachedTokens: input.cachedTokens ?? 0,
    totalTokens: input.totalTokens ?? 0,
    costUsd: input.costUsd ?? null,
    filesChanged: input.filesChanged ?? 0,
    additions: input.additions ?? 0,
    deletions: input.deletions ?? 0
  }
  store.addTask(task)
}

test('aggregates the inclusive/exclusive range and scopes it to the active workspace', () => {
  const { store, analytics } = fixture()
  addProject(store, 'project-a', 'Alpha project')
  addProject(store, 'project-b', 'Beta project')
  addTask(store, { id: 'before', startedAt: 99, inputTokens: 1000, totalTokens: 1000, costUsd: 100 })
  addTask(store, { id: 'at-end', startedAt: 200, inputTokens: 1000, totalTokens: 1000, costUsd: 100 })
  addTask(store, {
    id: 'success', startedAt: 100, status: 'succeeded', model: 'z-model', agentId: 'z-provider', agentLabel: 'Zulu',
    inputTokens: 1, outputTokens: 10, cachedTokens: 1, totalTokens: 11, costUsd: 1.25,
    workingTimeMs: 100, filesChanged: 1, additions: 2, deletions: 1
  })
  addTask(store, {
    id: 'failed', startedAt: 120, status: 'failed', model: 'z-model', agentId: 'z-provider', agentLabel: 'Zulu',
    inputTokens: 2, outputTokens: 10, cachedTokens: 1, totalTokens: 12, costUsd: null,
    workingTimeMs: 200, filesChanged: 2, additions: 4, deletions: 2
  })
  addTask(store, {
    id: 'cancelled', startedAt: 140, status: 'cancelled', model: 'a-model', agentId: 'a-provider', agentLabel: 'Alpha',
    inputTokens: 3, outputTokens: 10, cachedTokens: 1, totalTokens: 13, costUsd: 0,
    workingTimeMs: 300, filesChanged: 3, additions: 6, deletions: 3
  })
  addTask(store, {
    id: 'running', projectId: 'project-b', startedAt: 160, status: 'running', model: 'a-model', agentId: 'a-provider', agentLabel: 'Alpha',
    inputTokens: 4, outputTokens: 10, cachedTokens: 1, totalTokens: 14, costUsd: 2.5,
    workingTimeMs: 400, filesChanged: 4, additions: 8, deletions: 4
  })
  addTask(store, {
    id: 'pending', projectId: 'project-b', startedAt: 180, status: 'pending', agentId: 'middle-provider', agentLabel: 'Middle',
    inputTokens: 5, outputTokens: 10, cachedTokens: 1, totalTokens: 15, costUsd: null,
    workingTimeMs: 500, filesChanged: 5, additions: 10, deletions: 5
  })

  const other = store.createWorkspace('Other')
  store.selectWorkspace(other.id)
  addProject(store, 'other-project')
  addTask(store, { id: 'other-task', projectId: 'other-project', startedAt: 150, inputTokens: 999, totalTokens: 999, costUsd: 99 })
  expect(analytics(100, 200)).toMatchObject({
    tokens: { input: 999, total: 999 },
    tasks: { total: 1 }
  })

  store.selectWorkspace('default')
  const result = analytics(100, 200)
  expect(result).toMatchObject({
    range: { startAt: 100, endAt: 200 },
    tokens: { input: 15, output: 50, cached: 5, total: 65 },
    cost: { reportedUsd: 3.75, reportedTaskCount: 3, unreportedTaskCount: 2 },
    tasks: {
      total: 5,
      completed: 3,
      successful: 1,
      successRate: 1 / 3,
      statusCounts: { pending: 1, running: 1, succeeded: 1, failed: 1, cancelled: 1 }
    },
    favoriteModel: { key: 'a-model', label: 'a-model', taskCount: 2 },
    favoriteProvider: { key: 'a-provider', label: 'Alpha', taskCount: 2 },
    timing: { workingTimeMs: 1500, averageWorkingTimeMs: 300 },
    codeChanges: { filesChanged: 15, additions: 30, deletions: 15 }
  })
  expect(result.breakdowns.models.map(({ key, taskCount }) => ({ key, taskCount }))).toEqual([
    { key: 'a-model', taskCount: 2 },
    { key: 'z-model', taskCount: 2 }
  ])
  expect(result.breakdowns.providers.map(({ key, taskCount }) => ({ key, taskCount }))).toEqual([
    { key: 'a-provider', taskCount: 2 },
    { key: 'z-provider', taskCount: 2 },
    { key: 'middle-provider', taskCount: 1 }
  ])
  expect(result.breakdowns.statuses.map(({ key, taskCount }) => ({ key, taskCount }))).toEqual([
    { key: 'cancelled', taskCount: 1 },
    { key: 'failed', taskCount: 1 },
    { key: 'pending', taskCount: 1 },
    { key: 'running', taskCount: 1 },
    { key: 'succeeded', taskCount: 1 }
  ])
  expect(result.breakdowns.projects.map(({ key, taskCount, totalTokens }) => ({ key, taskCount, totalTokens }))).toEqual([
    { key: 'project-a', taskCount: 3, totalTokens: 36 },
    { key: 'project-b', taskCount: 2, totalTokens: 29 }
  ])
  expect(result.daily).toHaveLength(1)
  expect(result.daily[0]).toMatchObject({
    inputTokens: 15,
    outputTokens: 50,
    cachedTokens: 5,
    totalTokens: 65,
    reportedCostUsd: 3.75,
    taskCount: 5,
    statusCounts: { pending: 1, running: 1, succeeded: 1, failed: 1, cancelled: 1 },
    workingTimeMs: 1500,
    filesChanged: 15,
    additions: 30,
    deletions: 15
  })
})

test('groups daily chart values by the local task start date', () => {
  const { store, analytics } = fixture()
  addProject(store, 'project-a')
  const firstDay = new Date(2026, 8, 10)
  const secondDay = new Date(2026, 8, 11)
  const fourthDay = new Date(2026, 8, 13)
  addTask(store, {
    id: 'morning', startedAt: new Date(2026, 8, 10, 9).getTime(), status: 'succeeded',
    inputTokens: 10, outputTokens: 4, cachedTokens: 3, totalTokens: 14, costUsd: 0.25,
    workingTimeMs: 100, filesChanged: 1, additions: 5, deletions: 2
  })
  addTask(store, {
    id: 'evening', startedAt: new Date(2026, 8, 10, 17).getTime(), status: 'failed',
    inputTokens: 20, outputTokens: 8, cachedTokens: 6, totalTokens: 28, costUsd: null,
    workingTimeMs: 200, filesChanged: 2, additions: 10, deletions: 4
  })
  addTask(store, {
    id: 'later', startedAt: new Date(2026, 8, 12, 12).getTime(), status: 'cancelled',
    inputTokens: 30, outputTokens: 12, cachedTokens: 9, totalTokens: 42, costUsd: 0.75,
    workingTimeMs: 300, filesChanged: 3, additions: 15, deletions: 6
  })

  expect(analytics(firstDay.getTime(), fourthDay.getTime()).daily).toEqual([
    {
      date: '2026-09-10',
      inputTokens: 30,
      outputTokens: 12,
      cachedTokens: 9,
      totalTokens: 42,
      reportedCostUsd: 0.25,
      taskCount: 2,
      statusCounts: { pending: 0, running: 0, succeeded: 1, failed: 1, cancelled: 0 },
      workingTimeMs: 300,
      filesChanged: 3,
      additions: 15,
      deletions: 6
    },
    {
      date: '2026-09-12',
      inputTokens: 30,
      outputTokens: 12,
      cachedTokens: 9,
      totalTokens: 42,
      reportedCostUsd: 0.75,
      taskCount: 1,
      statusCounts: { pending: 0, running: 0, succeeded: 0, failed: 0, cancelled: 1 },
      workingTimeMs: 300,
      filesChanged: 3,
      additions: 15,
      deletions: 6
    }
  ])
  expect(analytics(firstDay.getTime(), secondDay.getTime()).daily).toHaveLength(1)
})

test('returns a complete empty result for a period without tasks', () => {
  const { analytics } = fixture()
  expect(analytics(1_000, 2_000)).toEqual({
    range: { startAt: 1_000, endAt: 2_000 },
    daily: [],
    tokens: { input: 0, output: 0, cached: 0, total: 0 },
    cost: { reportedUsd: 0, reportedTaskCount: 0, unreportedTaskCount: 0 },
    tasks: {
      total: 0,
      completed: 0,
      successful: 0,
      successRate: null,
      statusCounts: { pending: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 }
    },
    favoriteModel: null,
    favoriteProvider: null,
    timing: { workingTimeMs: 0, averageWorkingTimeMs: 0 },
    codeChanges: { filesChanged: 0, additions: 0, deletions: 0 },
    breakdowns: { providers: [], models: [], statuses: [], projects: [] }
  })
})

test('rejects malformed, non-finite, unsafe, empty and inverted ranges', () => {
  const { store } = fixture()
  const ipc = createHandlerRegistry()
  registerAnalyticsHandlers(ipc, store)
  for (const input of [
    undefined,
    { startAt: 0 },
    { startAt: '0', endAt: 1 },
    { startAt: 0, endAt: Number.NaN },
    { startAt: 0, endAt: Number.POSITIVE_INFINITY },
    { startAt: 0, endAt: Number.MAX_SAFE_INTEGER + 1 },
    { startAt: 10, endAt: 10 },
    { startAt: 11, endAt: 10 },
    { startAt: 0, endAt: 1, workspaceId: 'default' }
  ]) {
    expect(() => ipc.invoke('analytics:get', input)).toThrow('Invalid IPC request')
  }
})
