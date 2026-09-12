import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { vi } from 'vitest'
import { Store } from '../src/server/store'
import { GitDeliveryManager } from '../src/server/git'
import { TaskBranches } from '../src/server/tasks/task-branch'
import { TaskIssues } from '../src/server/tasks/task-issues'
import { onTestCleanup } from './test-cleanup'

export const branchGit = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
}).trim()

export async function taskBranchFixture() {
  const root = mkdtempSync(join(tmpdir(), 'anvil-task-branch-'))
  onTestCleanup(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  branchGit(repo, 'init', '-b', 'main')
  branchGit(repo, 'config', 'user.name', 'Test')
  branchGit(repo, 'config', 'user.email', 'test@example.invalid')
  branchGit(repo, 'commit', '--allow-empty', '-m', 'Base')
  const database = join(root, 'config.json')
  const options = { migrationsFolder: resolve('src/server/db/migrations') }
  const store = new Store(database, options)
  onTestCleanup(() => store.close())
  store.addProject({ id: 'project', name: 'Project', path: repo, createdAt: 0,
    monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
  const manager = new GitDeliveryManager(join(root, 'worktrees'))
  const prepared = await manager.prepareBranch(repo, 'task-a')
  const branchName = prepared.branchName
  const task = store.addTask({ cwd: prepared.cwd, baseBranch: prepared.baseBranch, baseCommit: prepared.baseCommit,
    branchName, id: 'task-a', projectId: 'project', agentId: 'codex', agentLabel: 'Codex',
    title: 'Title remains unchanged', prompt: 'Implement a change', status: 'running', deliveryStatus: 'working', startedAt: 1,
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null, filesChanged: 0, additions: 0, deletions: 0 })
  new TaskIssues(store).initialize(task.id, repo)
  const send = vi.fn()
  const branches = new TaskBranches({ store, gitDelivery: manager, send })
  const set = (name = 'feat/task-owned-name', check = () => {}) => branches.set(task.id, task.workspaceId, name, check)
  return { root, repo, database, options, store, manager, branches, task, send, set }
}
