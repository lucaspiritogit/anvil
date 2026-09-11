import { callIssueTool } from '../src/main/issue-tools/server'
import { rendererEvent } from './renderer-fixture'
import { expect, test, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { Store } from '../src/main/store'
import { GitDeliveryManager } from '../src/main/git-delivery'
import { registerTestIpc } from './test-ipc'
import { taskState } from './task-state'
import { handlers, testHome, AgentProcessManager } from './issue-tracker-doubles'
import type { AgentProcessManager as RealAgentProcessManager } from '../src/main/agents/process-manager'
import { registerTaskExecution } from '../src/main/tasks/task-execution'
import { TaskIssues } from '../src/main/tasks/task-issues'
import { createTaskCompletion } from '../src/main/tasks/completion'
import { onTestCleanup } from './test-cleanup'

const runGit = (cwd: string, ...args: string[]): string => execFileSync('git', args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
}).trim()

function barrier() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

async function turnFixture() {
  const root = join(testHome, randomUUID())
  const repo = join(root, 'project')
  mkdirSync(repo, { recursive: true })
  runGit(repo, 'init', '-b', 'main')
  runGit(repo, 'config', 'user.name', 'Anvil test')
  runGit(repo, 'config', 'user.email', 'anvil-test@example.invalid')
  runGit(repo, 'config', 'core.autocrlf', 'false')
  writeFileSync(join(repo, 'tracked.txt'), 'base\n')
  runGit(repo, 'add', '.')
  runGit(repo, 'commit', '-m', 'Base')
  const store = new Store(join(root, 'anvil.db'), { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') })
  onTestCleanup(() => store.close())
  store.addProject({ id: 'project', name: 'Project', path: repo, createdAt: 0,
    monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })
  const git = new GitDeliveryManager(join(root, 'worktrees'))
  const checkout = await git.prepareBranch(repo, 'task', 'Task')
  const task = store.addTask({ id: 'task', projectId: 'project', agentId: 'codex', agentLabel: 'Codex',
    prompt: 'Change files', title: 'Task changes', ...checkout, status: 'running', startedAt: 0,
    deliveryStatus: 'working', filesChanged: 0, additions: 0, deletions: 0,
    inputTokens: 0, outputTokens: 0, cachedTokens: 0, totalTokens: 0, costUsd: null })
  const agents = new AgentProcessManager()
  onTestCleanup(() => agents.close())
  const snapshots: { ready: boolean; phase?: string; head?: string; files: number }[] = []
  const context = { store, gitDelivery: git, agentProcesses: agents as unknown as RealAgentProcessManager,
    send: (channel: string) => {
      if (channel === 'task:updated' && store.getTask(task.id)) snapshots.push({
        ready: execution.issueReviewReady(task.id), phase: store.getTaskExecution(task.id)?.phase,
        head: store.getTask(task.id)?.headCommit, files: store.getTask(task.id)!.filesChanged
      })
    }, recordSystemEvent: () => {} }
  const finish = vi.fn(createTaskCompletion(context, () => {}, { rememberCompletedTask: async () => {} }))
  const execution = registerTaskExecution(context, finish)
  const state = execution.initializeTask(task.id, repo)
  const tracker = store.issueTracker(task.projectId, task.workspaceId)
  onTestCleanup(() => tracker.close())
  const fields = { parentId: state.parentIssueId, title: 'First', description: 'Change files',
    checklist: ['Verified'], validation: 'Check files', priority: 'medium' as const, labels: [] }
  const issue = tracker.create(fields)
  const next = tracker.create({ ...fields, title: 'Next', dependencies: [issue.id] })
  const issues = new TaskIssues(store)
  issues.finishPlanning(task.id)
  issues.claim(task.id, checkout.baseCommit)
  // Simulate the already dispatched issue agent; the test controls its exit.
  agents.active.add(task.id)
  const submit = () => callIssueTool(store, task.id, task.workspaceId, 'anvil_submit_review', {
    id: issue.id, checklist: [true], evidence: 'Verified the intended file contents'
  })
  const exit = () => {
    agents.active.delete(task.id)
    return execution.finishTaskTurn({ taskId: task.id, code: 0, cancelled: false })
  }
  return { repo, store, git, task, agents, execution, tracker, issue, next, submit, exit, snapshots, finish }
}

test('publishes the saved review range only after exit and delayed finalization, once per turn', async () => {
  const f = await turnFixture()
  writeFileSync(join(f.task.cwd, 'tracked.txt'), 'staged\n')
  runGit(f.task.cwd, 'add', 'tracked.txt')
  writeFileSync(join(f.task.cwd, 'tracked.txt'), 'staged and unstaged\n')
  writeFileSync(join(f.task.cwd, 'untracked.txt'), 'new file\n')
  f.submit()
  const reviewInput = () => f.execution.approveIssue(f.task.id)
  expect(f.execution.issueReviewReady(f.task.id)).toBe(false)
  await expect(reviewInput()).rejects.toThrow(/not finished stopping/)
  const entered = barrier()
  const commit = barrier()
  const saved = barrier()
  const publish = barrier()
  const original = f.git.finalizeBranch.bind(f.git)
  const finalize = vi.spyOn(f.git, 'finalizeBranch').mockImplementation(async (...args) => {
    entered.release()
    await commit.promise
    const result = await original(...args)
    saved.release()
    await publish.promise
    return result
  })
  const ending = f.exit()
  onTestCleanup(async () => { commit.release(); publish.release(); await ending })
  await entered.promise
  await f.execution.finishTaskTurn({ taskId: f.task.id, code: 0, cancelled: false })
  expect(finalize).toHaveBeenCalledTimes(1)
  expect(f.tracker.get(f.issue.id).headCommit).toBeUndefined()
  expect(f.execution.issueReviewReady(f.task.id)).toBe(false)
  await expect(reviewInput()).rejects.toThrow(/not finished stopping/)
  expect(() => f.execution.rejectIssue(f.task.id)).toThrow(/not finished stopping/)
  commit.release()
  await saved.promise
  const tip = runGit(f.task.cwd, 'rev-parse', 'HEAD')
  expect(tip).not.toBe(f.task.baseCommit)
  expect(f.tracker.get(f.issue.id).headCommit).toBeUndefined()
  expect(f.execution.issueReviewReady(f.task.id)).toBe(false)
  publish.release()
  await ending
  expect(f.snapshots.at(-1)).toEqual({ ready: true, phase: 'reviewing', head: tip, files: 2 })
  expect(f.tracker.get(f.issue.id)).toMatchObject({ baseCommit: f.task.baseCommit, headCommit: tip })
  expect(runGit(f.task.cwd, 'status', '--porcelain')).toBe('')
  const diff = await f.git.getIssueDiff(f.repo, new TaskIssues(f.store).issueDiffSource(f.task.id, f.issue.id))
  expect(diff?.patch).toContain('+staged and unstaged')
  expect(diff?.patch).toContain('untracked.txt')
  await f.exit()
  expect(finalize).toHaveBeenCalledTimes(1)
  expect(f.agents.starts).toHaveLength(0)
  await reviewInput()
  expect(f.tracker.get(f.next.id)).toMatchObject({ status: 'working', baseCommit: tip })
  expect(f.agents.starts).toHaveLength(1)
})

for (const interruption of ['cancel', 'delete', 'commit failure', 'missing worktree', 'wrong branch', 'invalid range'] as const) {
  test(`does not publish or advance a submitted issue after ${interruption} during finalization`, async () => {
    const f = await turnFixture()
    writeFileSync(join(f.task.cwd, 'untracked.txt'), 'unfinished\n')
    f.submit()
    const entered = barrier()
    const release = barrier()
    const original = f.git.finalizeBranch.bind(f.git)
    const finalize = vi.spyOn(f.git, 'finalizeBranch').mockImplementation(async (...args) => {
      entered.release()
      await release.promise
      return original(...args)
    })
    const ending = f.exit()
    onTestCleanup(async () => { release.release(); await ending })
    await entered.promise
    if (interruption === 'cancel') await f.execution.finishTaskTurn({ taskId: f.task.id, code: null, cancelled: true })
    if (interruption === 'delete') {
      f.execution.stopTask(f.task.id, 'Task deleted')
      f.store.deleteTaskCascade(f.task.id)
    }
    if (interruption === 'commit failure') {
      // A real failing commit hook preserves staged files for recovery.
      const hook = join(f.repo, '.git', 'hooks', 'pre-commit')
      writeFileSync(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    }
    if (interruption === 'missing worktree') runGit(f.repo, 'worktree', 'remove', '--force', f.task.cwd)
    if (interruption === 'wrong branch') runGit(f.task.cwd, 'checkout', '-b', 'unexpected')
    if (interruption === 'invalid range') f.tracker.recordCommits(f.issue.id, { baseCommit: 'missing-commit' })
    release.release()
    await ending
    expect(finalize).toHaveBeenCalledTimes(1)
    expect(f.execution.issueReviewReady(f.task.id)).toBe(false)
    expect(f.snapshots.some((snapshot) => snapshot.ready)).toBe(false)
    expect(f.agents.starts).toHaveLength(0)
    if (interruption === 'delete') {
      expect(f.store.getTask(f.task.id)).toBeUndefined()
      expect(f.finish).not.toHaveBeenCalled()
    } else {
      expect(f.store.getTaskExecution(f.task.id)?.phase).toBe('blocked')
      expect(f.store.getTask(f.task.id)).toMatchObject({
        status: interruption === 'cancel' ? 'cancelled' : 'pending', deliveryStatus: 'failed'
      })
      expect(f.tracker.get(f.issue.id).headCommit).toBeUndefined()
      expect(f.tracker.get(f.issue.id).status).toBe('blocked')
      expect(f.tracker.get(f.next.id).status).toBe('queued')
      if (interruption === 'commit failure') {
        expect(runGit(f.task.cwd, 'rev-parse', 'HEAD')).toBe(f.task.baseCommit)
        expect(runGit(f.task.cwd, 'status', '--porcelain')).toContain('untracked.txt')
      }
    }
  })
}

test('recovery and rework finalize remaining files while retaining the original issue base', async () => {
  const f = await turnFixture()
  writeFileSync(join(f.task.cwd, 'tracked.txt'), 'interrupted work\n')
  f.submit()
  f.agents.active.delete(f.task.id)
  const state = f.store.getTaskExecution(f.task.id)!
  f.store.saveTaskExecution({ ...state, phase: 'blocked', error: 'Restarted' })
  f.execution.resumeTask(f.task.id)
  await f.exit()
  const first = f.tracker.get(f.issue.id)
  expect(first.headCommit).toBe(runGit(f.task.cwd, 'rev-parse', 'HEAD'))
  expect(f.execution.issueReviewReady(f.task.id)).toBe(true)
  f.execution.rejectIssue(f.task.id)
  writeFileSync(join(f.task.cwd, 'tracked.txt'), 'reworked content\n')
  f.submit()
  await f.exit()
  const reworked = f.tracker.get(f.issue.id)
  expect(reworked.baseCommit).toBe(f.task.baseCommit)
  expect(reworked.headCommit).not.toBe(first.headCommit)
  const diff = await f.git.getIssueDiff(f.repo, reworked)
  expect(diff?.patch).toContain('+reworked content')
  expect(diff?.commits).toHaveLength(2)
  expect(f.snapshots.at(-1)?.ready).toBe(true)
})

test('runs parallel tasks in separate worktrees and delivers sequential changes as one final task diff', async () => {
  const projectPath = join(testHome, 'project')
  mkdirSync(projectPath)
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git(projectPath, 'init', '-b', 'main')
  git(projectPath, 'config', 'user.name', 'Anvil test')
  git(projectPath, 'config', 'user.email', 'anvil-test@example.invalid')
  writeFileSync(join(projectPath, '.gitignore'), '.anvil-composer/**\n.valence/**\n')
  git(projectPath, 'add', '.gitignore')
  git(projectPath, 'commit', '-m', 'Initial commit')
  const database = join(testHome, '.anvil-composer/config.json')
  const options = { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') }
  const seed = new Store(database, options)
  seed.addProject({ id: 'project', name: 'Git test', path: projectPath, createdAt: Date.now(), monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })

  const { agentProcesses: realAgentProcesses } = registerTestIpc()
  const agentProcesses = realAgentProcesses as unknown as AgentProcessManager
  const call = (name: string, input: unknown): any => handlers.get(name)!(rendererEvent, input)
  const waitFor = async (condition: () => boolean): Promise<void> => {
    const until = Date.now() + 10_000
    while (!condition()) {
      if (Date.now() > until) throw new Error('Timed out waiting for board transition')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  writeFileSync(join(projectPath, 'local.txt'), 'uncommitted user work\n')
  const dirty = await call('tasks:start', { projectId: 'project', agentId: 'codex', prompt: 'Do not commit user work' })
  expect(dirty.status, dirty.error).toBe('running')
  expect(dirty.cwd).not.toBe(projectPath)
  expect(existsSync(join(dirty.cwd, 'local.txt'))).toBe(false)
  expect(git(projectPath, 'branch', '--show-current')).toBe('main')
  const task = await call('tasks:start', { projectId: 'project', agentId: 'codex', prompt: 'Two independent files' })
  expect(task.status, task.error).toBe('running')
  expect(task.cwd).not.toBe(projectPath)
  expect(task.cwd).not.toBe(dirty.cwd)
  expect(git(projectPath, 'branch', '--show-current')).toBe('main')
  await waitFor(() => agentProcesses.starts.length === 2)
  const taskStarts = () => agentProcesses.starts.filter((start) => start.taskId === task.id)
  const item = { key: 'first', labels: ['files'], priority: 'medium' as const, dependencies: [], title: 'Add one file', description: 'One file per review', checklist: ['File exists'], validation: 'Read the file' }
  agentProcesses.plan(task.id, [item, { ...item, key: 'second', dependencies: ['first'] }])
  await waitFor(() => taskStarts().length === 2)
  let board = taskState(seed, task.id)!
  const firstCwd = taskStarts()[1].cwd
  expect(firstCwd).toBe(task.cwd)
  writeFileSync(join(firstCwd, 'first.txt'), 'first change\n')
  git(firstCwd, 'add', 'first.txt')
  git(firstCwd, 'commit', '-m', 'feat: first file')
  callIssueTool(seed, task.id, seed.getTask(task.id)!.workspaceId, 'anvil_submit_review', { id: board.items[0].id, checklist: [true], evidence: 'Read first.txt and verified its content' })
  seed.issueTracker('project').approve(board.items[0].id)
  agentProcesses.finishTurn(task.id, 'Submitted through the issue tool')
  await waitFor(() => taskStarts().length === 3)
  expect(git(firstCwd, 'branch', '--show-current')).toBe(task.branchName)
  expect(seed.getTask(task.id)?.deliveryStatus).toBe('working')
  const secondCwd = taskStarts()[2].cwd
  expect(existsSync(join(secondCwd, 'first.txt')), 'Next issue continues on the same task branch').toBeTruthy()
  writeFileSync(join(secondCwd, 'second.txt'), 'second change\n')
  // Exercise Anvil's fallback commit for an agent that leaves a dirty worktree.
  board = taskState(seed, task.id)!
  callIssueTool(seed, task.id, seed.getTask(task.id)!.workspaceId, 'anvil_submit_review', { id: board.items[1].id, checklist: [true], evidence: 'Read second.txt and verified its content' })
  seed.issueTracker('project').approve(board.items[1].id)
  agentProcesses.finishTurn(task.id, 'Submitted through the issue tool')
  await waitFor(() => seed.getTask(task.id)?.deliveryStatus === 'reviewable')
  expect(existsSync(secondCwd), 'Finalization retains the task worktree').toBe(true)
  expect(existsSync(join(projectPath, 'local.txt'))).toBe(true)
  expect(existsSync(dirty.cwd), 'The parallel task retains its own worktree').toBe(true)
  agentProcesses.finishTurn(dirty.id, 'No code changes')
  await waitFor(() => seed.getTask(dirty.id)?.deliveryStatus === 'no_changes')
  unlinkSync(join(projectPath, 'local.txt'))
  expect(git(projectPath, 'branch', '--show-current'), 'The project branch stays unchanged').toBe('main')
  expect(git(projectPath, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length).toBe(3)
  const wholeDiff = await call('tasks:diff', task.id)
  expect(wholeDiff?.patch).toMatch(/first.txt/)
  expect(wholeDiff?.patch).toMatch(/second.txt/)
  git(projectPath, 'checkout', '-b', 'user-current')
  const preview = await call('tasks:merge-preview', task.id)
  expect(preview.targetBranch).toBe('user-current')
  expect(preview.commitCount).toBe(2)
  await call('tasks:approve', { taskId: task.id, preview })
  expect(seed.getTask(task.id)?.deliveryStatus).toBe('approved')
  expect(seed.getTaskExecution(task.id)!.phase).toBe('complete')
  expect(git(projectPath, 'branch', '--show-current')).toBe('user-current')
  expect(existsSync(join(projectPath, 'first.txt'))).toBe(true)
  expect(existsSync(join(projectPath, 'second.txt'))).toBe(true)
  expect(git(projectPath, 'rev-parse', 'HEAD')).toBe(seed.getTask(task.id)?.headCommit)
  expect(git(projectPath, 'rev-parse', 'main')).not.toBe(git(projectPath, 'rev-parse', 'HEAD'))
  const startsBeforeGreeting = agentProcesses.starts.length
  const greeting = await call('tasks:start', { projectId: 'project', agentId: 'codex', prompt: 'hello' })
  await waitFor(() => agentProcesses.starts.length === startsBeforeGreeting + 1)
  const greetingWorktree = agentProcesses.starts.at(-1).cwd
  agentProcesses.finishTurn(greeting.id, 'Hello!')
  await waitFor(() => seed.getTask(greeting.id)?.deliveryStatus === 'no_changes')
  expect(seed.getTask(greeting.id)?.status).toBe('succeeded')
  expect(seed.getTaskExecution(greeting.id)?.phase).toBe('complete')
  expect(agentProcesses.starts.length).toBe(startsBeforeGreeting + 1)
  expect(existsSync(greetingWorktree), 'No-work tasks retain their worktree until settlement').toBe(true)
  expect(git(projectPath, 'branch', '--show-current')).toBe('user-current')
  expect(seed.getTask(greeting.id)?.headCommit).toBe(seed.getTask(greeting.id)?.baseCommit)
  await call('tasks:settle', greeting.id)
  await waitFor(() => !existsSync(greetingWorktree))
  expect(existsSync(task.cwd), 'Settling another task leaves this worktree intact').toBe(true)
  await call('tasks:delete', task.id)
  await waitFor(() => !existsSync(task.cwd))
  expect(git(projectPath, 'rev-parse', task.branchName), 'Deleting a task preserves its committed branch').toBeTruthy()
  seed.close()
})

test('captures a per-issue diff range at claim and submit, re-captures after rework, and falls back for legacy issues', async () => {
  const projectPath = join(testHome, 'issue-ranges-project')
  mkdirSync(projectPath)
  const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
  git(projectPath, 'init', '-b', 'main')
  git(projectPath, 'config', 'user.name', 'Anvil test')
  git(projectPath, 'config', 'user.email', 'anvil-test@example.invalid')
  writeFileSync(join(projectPath, '.gitignore'), '.anvil-composer/**\n.valence/**\n')
  git(projectPath, 'add', '.gitignore')
  git(projectPath, 'commit', '-m', 'Initial commit')
  const database = join(testHome, '.anvil-composer/config.json')
  const options = { migrationsFolder: join(process.cwd(), 'src/main/db/migrations') }
  const store = new Store(database, options)
  store.addProject({ id: 'issue-ranges', name: 'Issue ranges', path: projectPath, createdAt: Date.now(), monthlyTokenLimit: null, monthlyCostLimitUsd: null, finishOnPush: false, gitPlatform: 'github' })

  const { agentProcesses: realAgentProcesses } = registerTestIpc()
  const agentProcesses = realAgentProcesses as unknown as AgentProcessManager
  const call = (name: string, input: unknown): any => handlers.get(name)!(rendererEvent, input)
  const waitFor = async (condition: () => boolean): Promise<void> => {
    const until = Date.now() + 10_000
    while (!condition()) {
      if (Date.now() > until) throw new Error('Timed out waiting for board transition')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  const delivery = new GitDeliveryManager(join(store.getWorkspaceDirectory('default'), 'worktrees'))

  const task = await call('tasks:start', { projectId: 'issue-ranges', agentId: 'codex', prompt: 'Two reviewed files' })
  expect(task.status, task.error).toBe('running')
  await waitFor(() => agentProcesses.starts.length === 1)
  const item = { key: 'first', labels: [], priority: 'medium' as const, dependencies: [], title: 'Add one file', description: 'One file per review', checklist: ['File exists'], validation: 'Read the file' }
  agentProcesses.plan(task.id, [item, { ...item, key: 'second', dependencies: ['first'] }])
  await waitFor(() => agentProcesses.starts.length === 2)

  const firstCwd = agentProcesses.starts[1].cwd
  writeFileSync(join(firstCwd, 'first.txt'), 'first change\n')
  git(firstCwd, 'add', 'first.txt')
  git(firstCwd, 'commit', '-m', 'feat: first file')
  const firstHead = git(firstCwd, 'rev-parse', 'HEAD')
  let board = taskState(store, task.id)!
  callIssueTool(store, task.id, store.getTask(task.id)!.workspaceId, 'anvil_submit_review', { id: board.items[0].id, checklist: [true], evidence: 'Read first.txt and verified its content' })
  agentProcesses.finishTurn(task.id, 'Completed the first issue')
  await waitFor(() => store.getTaskExecution(task.id)?.phase === 'reviewing')
  const firstReview = await call('tasks:issue-diff', { taskId: task.id, issueId: board.items[0].id })
  expect(firstReview.patch).toContain('first.txt')
  expect(firstReview.patch).not.toContain('second.txt')
  await call('tasks:approve-issue', { taskId: task.id, issueId: board.items[0].id, headCommit: firstHead })
  await waitFor(() => agentProcesses.starts.length === 3)

  const secondCwd = agentProcesses.starts[2].cwd
  writeFileSync(join(secondCwd, 'second.txt'), 'second attempt\n')
  git(secondCwd, 'add', 'second.txt')
  git(secondCwd, 'commit', '-m', 'feat: second attempt')
  board = taskState(store, task.id)!
  callIssueTool(store, task.id, store.getTask(task.id)!.workspaceId, 'anvil_submit_review', { id: board.items[1].id, checklist: [true], evidence: 'Read second.txt and verified its content' })
  agentProcesses.finishTurn(task.id, 'Second attempt ready for review')
  await waitFor(() => store.getTaskExecution(task.id)?.phase === 'reviewing')
  const secondReview = await call('tasks:issue-diff', { taskId: task.id, issueId: board.items[1].id })
  expect(secondReview.patch).toContain('second.txt')
  expect(secondReview.patch).not.toContain('first.txt')
  await call('tasks:reject-issue', { taskId: task.id, issueId: board.items[1].id,
    headCommit: git(secondCwd, 'rev-parse', 'HEAD'), comment: 'Rework the second file' })
  await waitFor(() => agentProcesses.starts.length === 4)
  expect(agentProcesses.starts[3].cwd).toBe(firstCwd)
  writeFileSync(join(secondCwd, 'second.txt'), 'second rework\n')
  git(secondCwd, 'add', 'second.txt')
  git(secondCwd, 'commit', '-m', 'fix: second rework')
  const reworkHead = git(secondCwd, 'rev-parse', 'HEAD')
  callIssueTool(store, task.id, store.getTask(task.id)!.workspaceId, 'anvil_submit_review', { id: board.items[1].id, checklist: [true], evidence: 'Rework verified against second.txt' })
  agentProcesses.finishTurn(task.id, 'Reworked and completed')
  await waitFor(() => store.getTaskExecution(task.id)?.phase === 'reviewing')
  const reworkReview = await call('tasks:issue-diff', { taskId: task.id, issueId: board.items[1].id })
  expect(reworkReview.patch).toContain('second rework')
  expect(reworkReview.patch).not.toContain('first.txt')
  await call('tasks:approve-issue', { taskId: task.id, issueId: board.items[1].id, headCommit: reworkHead })
  await waitFor(() => store.getTask(task.id)?.deliveryStatus === 'reviewable')

  const [first, second] = taskState(store, task.id)!.items
  const taskHead = store.getTask(task.id)!.headCommit!
  expect(first.status).toBe('complete')
  expect(first.baseCommit, 'Claim records the worktree HEAD as the issue base').toBe(task.baseCommit)
  expect(first.headCommit, 'Turn end records the submitted HEAD').toBe(firstHead)
  expect(second.baseCommit, 'The next issue starts where the previous one ended').toBe(firstHead)
  expect(second.headCommit, 'Rework resubmission re-records the HEAD').toBe(reworkHead)

  const firstDiff = await delivery.getIssueDiff(projectPath, {
    baseCommit: first.baseCommit, headCommit: first.headCommit,
    taskBaseCommit: task.baseCommit, taskHeadCommit: taskHead
  })
  expect(firstDiff?.patch).toMatch(/first\.txt/)
  expect(firstDiff?.patch).not.toMatch(/second\.txt/)
  expect(firstDiff?.commits.map(({ subject }) => subject)).toEqual(['feat: first file'])

  const secondDiff = await delivery.getIssueDiff(projectPath, { baseCommit: second.baseCommit, headCommit: second.headCommit })
  expect(secondDiff?.patch).toMatch(/second\.txt/)
  expect(secondDiff?.patch).not.toMatch(/first\.txt/)
  expect(secondDiff?.commits.map(({ subject }) => subject).sort()).toEqual(['feat: second attempt', 'fix: second rework'])

  const connection = new Database(store.getWorkspaceDatabasePath('default'), { fileMustExist: true })
  try {
    connection.prepare('UPDATE issues SET base_commit = NULL, head_commit = NULL WHERE id = ?').run(first.id)
  } finally {
    connection.close()
  }
  const legacy = taskState(store, task.id)!.items[0]
  expect(legacy.baseCommit).toBeUndefined()
  const legacyDiff = await delivery.getIssueDiff(projectPath, {
    baseCommit: legacy.baseCommit, headCommit: legacy.headCommit,
    taskBaseCommit: task.baseCommit, taskHeadCommit: taskHead
  })
  expect(legacyDiff?.patch).toMatch(/first\.txt/)
  expect(legacyDiff?.patch).toMatch(/second\.txt/)
  expect(legacyDiff?.commits).toHaveLength(3)
  expect(await delivery.getIssueDiff(projectPath, {})).toBeNull()
  expect(await delivery.getIssueDiff(projectPath, {
    baseCommit: task.baseCommit, taskBaseCommit: task.baseCommit, taskHeadCommit: taskHead
  }), 'A new unfinished range must not fall back to the aggregate diff').toBeNull()
  store.close()
})
