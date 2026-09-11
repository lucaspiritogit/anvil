import { test, expect } from 'vitest'
import { join } from 'node:path'
import { resolveAppDataDirectory } from '../src/shared/app-data'
import { Store } from '../src/server/store'
import type { Task } from '../src/shared/types'
import { testHome } from './issue-tracker-doubles'

test('separates development storage from live packaged tasks', () => {
  const options = { migrationsFolder: join(process.cwd(), 'src/server/db/migrations') }
  const productionDirectory = resolveAppDataDirectory(testHome, true)
  const developmentDirectory = resolveAppDataDirectory(testHome, false)
  const production = new Store(join(productionDirectory, 'anvil.db'), options)
  production.addProject({ id: 'project', name: 'Production', path: testHome, createdAt: 0, monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
  const task: Task = {
    workspaceId: 'default',
    id: 'live', projectId: 'project', title: 'Live task', prompt: 'Work', agentId: 'codex', agentLabel: 'Codex',
    cwd: testHome, status: 'running', deliveryStatus: 'working', startedAt: 1,
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null,
    filesChanged: 0, additions: 0, deletions: 0
  }
  production.addTask(task)
  production.saveTaskExecution({ taskId: task.id, projectPath: testHome, parentIssueId: 'parent', phase: 'working', issueIds: ['issue'], currentIssueId: 'issue', error: null })
  production.setSettings({ overviewBackgroundColor: '#123456' })
  const development = new Store(join(developmentDirectory, 'anvil.db'), options)
  try {
    expect(production.getTask(task.id)?.status, 'Opening development must not interrupt a live packaged-app task').toBe('running')
    expect(production.getTaskExecution(task.id)?.phase).toBe('working')
    expect(development.getTasks()).toStrictEqual([])
    development.setSettings({ overviewBackgroundColor: '#abcdef' })
    expect(production.getSettings().overviewBackgroundColor).toBe('#123456')
  } finally {
    development.close()
    production.close()
  }
})

test('resolves packaged, development and explicit profile paths', () => {
  const productionDirectory = resolveAppDataDirectory(testHome, true)
  const developmentDirectory = resolveAppDataDirectory(testHome, false)
  expect(productionDirectory, 'Keep existing packaged app data').toBe(join(testHome, '.anvil-composer'))
  expect(developmentDirectory).toBe(join(testHome, '.anvil-composer-dev'))
  const isolated = join(testHome, 'isolated')
  expect(resolveAppDataDirectory(testHome, true, isolated)).toBe(isolated)
  expect(resolveAppDataDirectory(testHome, false, isolated)).toBe(isolated)
  expect(() => resolveAppDataDirectory(testHome, false, 'relative')).toThrow(/absolute/)
})
