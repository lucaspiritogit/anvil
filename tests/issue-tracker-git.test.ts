import { callIssueTool } from '../src/main/issue-tools/server'
import { rendererEvent } from './renderer-fixture'
import { expect, test } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { Store } from '../src/main/store'
import { GitDeliveryManager } from '../src/main/git-delivery'
import { registerTestIpc } from './test-ipc'
import { taskState } from './task-state'
import { handlers, testHome, AgentProcessManager } from './issue-tracker-doubles'

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
  store.issueTracker('issue-ranges').approve(board.items[0].id)
  agentProcesses.finishTurn(task.id, 'Completed the first issue')
  await waitFor(() => agentProcesses.starts.length === 3)

  const secondCwd = agentProcesses.starts[2].cwd
  writeFileSync(join(secondCwd, 'second.txt'), 'second attempt\n')
  git(secondCwd, 'add', 'second.txt')
  git(secondCwd, 'commit', '-m', 'feat: second attempt')
  board = taskState(store, task.id)!
  callIssueTool(store, task.id, store.getTask(task.id)!.workspaceId, 'anvil_submit_review', { id: board.items[1].id, checklist: [true], evidence: 'Read second.txt and verified its content' })
  store.issueTracker('issue-ranges').reject(board.items[1].id)
  writeFileSync(join(secondCwd, 'second.txt'), 'second rework\n')
  git(secondCwd, 'add', 'second.txt')
  git(secondCwd, 'commit', '-m', 'fix: second rework')
  const reworkHead = git(secondCwd, 'rev-parse', 'HEAD')
  callIssueTool(store, task.id, store.getTask(task.id)!.workspaceId, 'anvil_submit_review', { id: board.items[1].id, checklist: [true], evidence: 'Rework verified against second.txt' })
  store.issueTracker('issue-ranges').approve(board.items[1].id)
  agentProcesses.finishTurn(task.id, 'Reworked and completed')
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
  store.close()
})
