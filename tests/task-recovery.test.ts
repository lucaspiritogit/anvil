import { expect, test, vi } from 'vitest'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import { Store } from '../src/server/store'
import type { Task } from '../src/shared/types'
import { migrateBefore, migrationsFolder } from './migration-fixture'
import { onTestCleanup } from './test-cleanup'
import { testHome, AgentProcessManager } from './issue-tracker-doubles'
import type { AgentProcessManager as RealAgentProcessManager } from '../src/server/agents/process-manager'
import { taskBranchFixture, branchGit } from './task-branch-fixture'
import { TaskBranches, taskBranchNaming } from '../src/server/tasks/task-branch'
import { GitDeliveryManager } from '../src/server/git-delivery'
import { resumeTaskTurn } from '../src/server/tasks/resume'
import { taskRecoveryPrompt } from '../src/server/agents/task-prompts'
import { TaskIssues } from '../src/server/tasks/task-issues'

async function resumedFixture(kind: 'temporary' | 'accepted' | 'legacy' | 'unprepared' | 'non-Git') {
  const f = await taskBranchFixture()
  if (kind === 'accepted' || kind === 'legacy') await f.set(kind === 'accepted' ? 'feat/saved-name' : 'old-prompt-title-task-a')
  if (kind === 'unprepared' || kind === 'non-Git') {
    await f.manager.releaseWorktree(f.task.id)
    branchGit(f.repo, 'branch', '-D', f.task.branchName!)
    f.store.updateTask(f.task.id, { branchName: undefined, baseBranch: undefined, baseCommit: undefined })
  }
  if (kind === 'temporary') await expect(f.set('invalid name')).rejects.toThrow()
  new TaskIssues(f.store).stop(f.task.id, 'Interrupted before dispatch or branch acceptance')
  f.store.updateTask(f.task.id, { status: 'pending', sessionId: 'saved-session', model: 'saved-model',
    deliveryStatus: kind === 'non-Git' ? 'unavailable' : 'agent_failed' })
  f.store.close()
  const store = new Store(f.database, f.options)
  onTestCleanup(() => store.close())
  const gitDelivery = new GitDeliveryManager(join(f.root, 'worktrees'))
  const agents = new AgentProcessManager()
  onTestCleanup(() => agents.close())
  const context = { store, gitDelivery, agentProcesses: agents as unknown as RealAgentProcessManager, send: vi.fn() }
  const issues = new TaskIssues(store)
  const resume = () => resumeTaskTurn(context, {
    check: () => store.getTask(f.task.id)!, validate: () => {},
    prompt: (task, state) => taskRecoveryPrompt(task, state!),
    resumeExecution: (id) => issues.resume(id), acceptExecution: (id) => issues.acceptResume(id),
    rollbackExecution: (id, state) => issues.rollbackResume(id, state)
  })
  return { ...f, store, gitDelivery, agents, context, resume }
}

test.each(['temporary', 'accepted', 'legacy'] as const)('restart and resume preserve %s names and the executing agent settings', async (kind) => {
  const f = await resumedFixture(kind)
  const saved = f.store.getTask(f.task.id)!
  const prepare = vi.spyOn(f.gitDelivery, 'prepareBranch')
  const resumed = await f.resume()
  expect(prepare).not.toHaveBeenCalled()
  expect(resumed).toMatchObject({ branchName: saved.branchName, title: f.task.title, prompt: f.task.prompt,
    agentId: f.task.agentId, model: 'saved-model', sessionId: 'saved-session', cwd: f.task.cwd })
  expect(f.agents.starts).toHaveLength(1)
  expect(f.agents.starts[0]).toMatchObject({ agent: { id: f.task.agentId }, model: 'saved-model', resumeSessionId: 'saved-session' })
  const branches = new TaskBranches(f.context)
  expect(taskBranchNaming(resumed).canNameBranch).toBe(kind === 'temporary')
  if (kind === 'temporary') {
    await branches.set(resumed.id, resumed.workspaceId, 'fix/recovered-name', () => {})
    expect(f.store.getTask(resumed.id)?.branchName).toBe('fix/recovered-name')
  } else {
    await expect(branches.set(resumed.id, resumed.workspaceId, 'fix/replacement', () => {})).rejects.toThrow('established')
  }
  expect(branchGit(resumed.cwd, 'branch', '--show-current')).toBe(f.store.getTask(resumed.id)?.branchName)
})

test('failed resumed dispatch retains a new temporary checkout for a retry without a title fallback', async () => {
  const f = await resumedFixture('unprepared')
  const prepare = vi.spyOn(f.gitDelivery, 'prepareBranch')
  vi.spyOn(f.agents, 'startResumed').mockRejectedValueOnce(new Error('Dispatch interrupted'))
  await expect(f.resume()).rejects.toThrow('Dispatch interrupted')
  expect(f.store.getTask(f.task.id)).toMatchObject({ status: 'pending', branchName: f.task.branchName, baseCommit: f.task.baseCommit })
  expect(branchGit(f.task.cwd, 'branch', '--show-current')).toBe(f.task.branchName)
  const resumed = await f.resume()
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(prepare).toHaveBeenCalledWith(f.repo, f.task.id, expect.any(Function), undefined)
  expect(taskBranchNaming(resumed).canNameBranch).toBe(true)
  await new TaskBranches(f.context).set(resumed.id, resumed.workspaceId, 'fix/resumed-checkout', () => {})
  expect(f.store.getTask(resumed.id)).toMatchObject({ branchName: 'fix/resumed-checkout', title: f.task.title })
})

test('non-Git delivery skips branch preparation and naming on resume', async () => {
  const f = await resumedFixture('non-Git')
  const prepare = vi.spyOn(f.gitDelivery, 'prepareBranch')
  const resumed = await f.resume()
  expect(prepare).not.toHaveBeenCalled()
  expect(resumed.deliveryStatus).toBe('unavailable')
  expect(taskBranchNaming(resumed)).toEqual({ branchName: null, canNameBranch: false })
  await expect(new TaskBranches(f.context).set(resumed.id, resumed.workspaceId, 'feat/no-git', () => {})).rejects.toThrow('unavailable')
  expect(f.agents.starts).toHaveLength(1)
})

test('migrates interrupted tasks while retaining sessions, output and execution state', () => {
  const database = join(testHome, 'recovery.db')
  migrateBefore(database, 1)
  const legacyDb = new Database(database)
  onTestCleanup(() => { if (legacyDb.open) legacyDb.close() })
  legacyDb.prepare("INSERT INTO projects (id, name, path, created_at) VALUES ('project', 'Test', ?, 0)").run(testHome)
  const base: Task = {
    workspaceId: 'default',
    id: 'running', projectId: 'project', title: 'Task', prompt: 'Task', agentId: 'codex', agentLabel: 'Codex',
    cwd: testHome, status: 'running', deliveryStatus: 'working', startedAt: 1,
    inputTokens: 10, outputTokens: 5, cachedTokens: 0, totalTokens: 15, costUsd: null,
    filesChanged: 0, additions: 0, deletions: 0, sessionId: 'saved-session', branchName: 'saved-branch'
  }
  for (const [id, patch] of Object.entries({
    running: {},
    finalizing: { status: 'succeeded', deliveryStatus: 'finalizing' },
    legacy: { status: 'cancelled', deliveryStatus: 'finalizing' },
    stopped: { status: 'cancelled', deliveryStatus: 'finalizing' },
    finished: { status: 'succeeded', deliveryStatus: 'reviewable' },
    cancelled: { status: 'cancelled', deliveryStatus: 'agent_failed' },
    review: { status: 'failed', deliveryStatus: 'agent_failed' }
  }) as [string, Partial<Task>][]) {
    legacyDb.prepare(`INSERT INTO tasks (id, project_id, title, prompt, agent_id, agent_label,
      cwd, status, delivery_status, started_at, input_tokens, output_tokens, cached_tokens,
      total_tokens, cost_usd, files_changed, additions, deletions, session_id, branch_name)
      VALUES (@id, @projectId, @title, @prompt, @agentId, @agentLabel, @cwd, @status,
      @deliveryStatus, @startedAt, @inputTokens, @outputTokens, @cachedTokens, @totalTokens,
      @costUsd, @filesChanged, @additions, @deletions, @sessionId, @branchName)`)
      .run({ ...base, ...patch, id })
    legacyDb.prepare('INSERT INTO task_events (id, task_id, ts, stream, kind, category, text) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(`${id}-event`, id, 2, 'system', 'output', 'system', id === 'stopped' ? 'Stop requested by user.' : 'Saved output')
    legacyDb.prepare('INSERT INTO task_executions (task_id, state) VALUES (?, ?)').run(id, JSON.stringify({ taskId: id, projectPath: testHome, parentIssueId: 'saved-parent',
      phase: id === 'running' ? 'working' : id === 'review' ? 'reviewing' : 'blocked',
      issueIds: ['saved-issue'], currentIssueId: 'saved-issue', error: null }))
  }
  legacyDb.prepare("UPDATE tasks SET ended_at = 9000000 WHERE id = 'finished'").run()
  legacyDb.close()
  const store = new Store(database, { migrationsFolder })
  try {
    for (const task of store.getTasks()) {
      expect(task.workingTimeMs, 'Legacy lifetimes cannot reconstruct historical review gaps').toBe(0)
      expect(task.workingStartedAt).toBeUndefined()
    }
    for (const id of ['running', 'finalizing', 'legacy']) {
      expect(store.getTask(id)?.status).toBe('pending')
      expect(store.getTask(id)?.deliveryStatus).toBe('agent_failed')
    }
    expect(store.getTask('stopped')?.status).toBe('cancelled')
    expect(store.getTask('stopped')?.deliveryStatus, 'Explicit Stop still clears stale finalization').toBe('agent_failed')
    expect(store.getTask('cancelled')?.status).toBe('cancelled')
    expect(store.getTask('finished')?.status).toBe('succeeded')
    expect(store.getTask('finished')?.deliveryStatus).toBe('reviewable')
    for (const task of store.getTasks().filter((task) => task.id !== 'review')) {
      expect(task.sessionId).toBe('saved-session')
      expect(task.branchName).toBe('saved-branch')
      expect(task.totalTokens).toBe(15)
      expect(store.readEvents(task.id), 'Migration retains legacy output without guessing its issue from recovery state').toEqual([{
        id: `${task.id}-event`, taskId: task.id, issueId: undefined, ts: 2, stream: 'system',
        kind: 'output', category: 'system', text: task.id === 'stopped' ? 'Stop requested by user.' : 'Saved output'
      }])
      expect(store.getTaskExecution(task.id)?.currentIssueId).toBe('saved-issue')
      expect(store.getTaskExecution(task.id)?.phase).toBe('blocked')
    }
    expect(store.getTask('review')?.status).toBe('failed')
    expect(store.getTaskExecution('review')?.currentIssueId).toBe('saved-issue')
    expect(store.getTaskExecution('review')?.phase, 'An issue awaiting review survives a restart without being blocked').toBe('reviewing')
  } finally {
    store.close()
  }
})
